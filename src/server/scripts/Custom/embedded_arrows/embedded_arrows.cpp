/*
 * This file is part of the TrinityCore Project. See AUTHORS file for Copyright information
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the
 * Free Software Foundation; either version 2 of the License, or (at your
 * option) any later version.
 */

#include "embedded_arrow_logic.h"
#include "Config.h"
#include "GameObject.h"
#include "GameObjectAI.h"
#include "GameTime.h"
#include "Item.h"
#include "Log.h"
#include "Map.h"
#include "ObjectMgr.h"
#include "Player.h"
#include "Random.h"
#include "ScriptMgr.h"
#include "Spell.h"
#include "SpellAuras.h"
#include "SpellInfo.h"
#include "SpellMgr.h"
#include "StringConvert.h"
#include "WorldSession.h"
#include <array>
#include <cctype>
#include <cmath>
#include <map>
#include <mutex>
#include <optional>
#include <set>

namespace
{
constexpr uint32 SPELL_ARROWS_IN_CHEST = 63088;
constexpr uint32 GO_RECOVERABLE_ARROW = 900001;

enum RecoverableArrowData
{
    DATA_ARROW_ITEM = 1,
    DATA_ARROW_EXPIRATION = 2,
    DATA_ARROW_OWNER = 3
};

struct EmbeddedArrowConfig
{
    bool Enabled = true;
    bool AllowAllArrowAmmo = false;
    uint32 LifetimeSeconds = 3 * MINUTE;
    uint32 RecoveryChance = 50;
    uint32 MaxArrowsPerPlayer = 50;
    std::set<uint32> AmmoItemIds;
};

struct ArrowStateSnapshot
{
    uint32 Count = 0;
    time_t LatestExpiration = 0;
};

struct AddedArrow
{
    EmbeddedArrows::ArrowRecord Record;
    ArrowStateSnapshot State;
};

std::string_view TrimWhitespace(std::string_view value)
{
    while (!value.empty() && std::isspace(static_cast<unsigned char>(value.front())))
        value.remove_prefix(1);

    while (!value.empty() && std::isspace(static_cast<unsigned char>(value.back())))
        value.remove_suffix(1);

    return value;
}

class EmbeddedArrowManager
{
public:
    static EmbeddedArrowManager& Instance()
    {
        static EmbeddedArrowManager instance;
        return instance;
    }

    void LoadConfig()
    {
        EmbeddedArrowConfig config;
        config.Enabled = sConfigMgr->GetBoolDefault("EmbeddedArrows.Enable", true);
        config.LifetimeSeconds = BoundConfigValue("EmbeddedArrows.LifetimeSeconds", 3 * MINUTE, 1, 30 * MINUTE);
        config.RecoveryChance = BoundConfigValue("EmbeddedArrows.RecoveryChance", 50, 0, 100);
        config.MaxArrowsPerPlayer = BoundConfigValue("EmbeddedArrows.MaxPerPlayer", 50, 1, 255);

        std::string configuredAmmo = sConfigMgr->GetStringDefault("EmbeddedArrows.AmmoItemIds", "41165,52021");
        std::string_view configuredAmmoView = TrimWhitespace(configuredAmmo);
        if (configuredAmmoView == "*")
            config.AllowAllArrowAmmo = true;
        else
        {
            for (std::string_view token : Trinity::Tokenize(configuredAmmoView, ',', false))
            {
                token = TrimWhitespace(token);
                if (Optional<uint32> itemId = Trinity::StringTo<uint32>(token))
                    config.AmmoItemIds.insert(*itemId);
                else
                    TC_LOG_ERROR("scripts", "EmbeddedArrows: '{}' is not a valid ammo item id.", std::string(token));
            }
        }

        std::lock_guard<std::mutex> lock(_mutex);
        _config = std::move(config);

        TC_LOG_INFO("scripts", "EmbeddedArrows: {} with {} second lifetime, {}% recovery chance, and {} tracked arrows per player.",
            _config.Enabled ? "enabled" : "disabled", _config.LifetimeSeconds, _config.RecoveryChance, _config.MaxArrowsPerPlayer);
    }

    bool IsEnabled() const
    {
        std::lock_guard<std::mutex> lock(_mutex);
        return _config.Enabled;
    }

    bool IsConfiguredAmmo(uint32 itemId) const
    {
        std::lock_guard<std::mutex> lock(_mutex);
        return _config.AllowAllArrowAmmo || _config.AmmoItemIds.count(itemId) != 0;
    }

    std::optional<AddedArrow> AddArrow(Player* victim, Player const* shooter, uint32 itemId)
    {
        time_t now = GameTime::GetGameTime();
        std::lock_guard<std::mutex> lock(_mutex);
        if (!_config.Enabled)
            return std::nullopt;

        std::vector<EmbeddedArrows::ArrowRecord>& arrows = _arrows[victim->GetGUID().GetCounter()];
        EmbeddedArrows::RemoveExpired(arrows, now);
        if (arrows.size() >= _config.MaxArrowsPerPlayer)
            return std::nullopt;

        EmbeddedArrows::ArrowRecord record;
        record.Id = _nextArrowId++;
        record.ShooterGuid = shooter->GetGUID().GetCounter();
        record.ItemId = itemId;
        record.ExpiresAt = now + _config.LifetimeSeconds;
        arrows.push_back(record);

        return AddedArrow{ record, MakeSnapshot(arrows) };
    }

    void ExpireArrow(Player* victim, uint64 arrowId)
    {
        ArrowStateSnapshot snapshot;
        {
            std::lock_guard<std::mutex> lock(_mutex);
            auto stateItr = _arrows.find(victim->GetGUID().GetCounter());
            if (stateItr == _arrows.end())
                return;

            std::vector<EmbeddedArrows::ArrowRecord>& arrows = stateItr->second;
            arrows.erase(std::remove_if(arrows.begin(), arrows.end(), [arrowId](EmbeddedArrows::ArrowRecord const& arrow)
            {
                return arrow.Id == arrowId;
            }), arrows.end());
            EmbeddedArrows::RemoveExpired(arrows, GameTime::GetGameTime());

            snapshot = MakeSnapshot(arrows);
            if (arrows.empty())
                _arrows.erase(stateItr);
        }

        SyncVisual(victim, snapshot);
    }

    void RestorePlayer(Player* player)
    {
        std::vector<EmbeddedArrows::ArrowRecord> records;
        ArrowStateSnapshot snapshot;
        {
            std::lock_guard<std::mutex> lock(_mutex);
            auto stateItr = _arrows.find(player->GetGUID().GetCounter());
            if (stateItr == _arrows.end())
            {
                snapshot = { };
            }
            else
            {
                EmbeddedArrows::RemoveExpired(stateItr->second, GameTime::GetGameTime());
                if (stateItr->second.empty())
                {
                    _arrows.erase(stateItr);
                    snapshot = { };
                }
                else
                {
                    records = stateItr->second;
                    snapshot = MakeSnapshot(records);
                }
            }
        }

        SyncVisual(player, snapshot);
        for (EmbeddedArrows::ArrowRecord const& record : records)
            ScheduleExpiration(player, record);
    }

    std::vector<EmbeddedArrows::ArrowRecord> TakeArrows(Player* victim)
    {
        std::lock_guard<std::mutex> lock(_mutex);
        auto stateItr = _arrows.find(victim->GetGUID().GetCounter());
        if (stateItr == _arrows.end())
            return { };

        EmbeddedArrows::RemoveExpired(stateItr->second, GameTime::GetGameTime());
        std::vector<EmbeddedArrows::ArrowRecord> arrows = std::move(stateItr->second);
        _arrows.erase(stateItr);
        return arrows;
    }

    void RemovePlayer(ObjectGuid guid)
    {
        std::lock_guard<std::mutex> lock(_mutex);
        _arrows.erase(guid.GetCounter());
    }

    void PruneExpired()
    {
        std::lock_guard<std::mutex> lock(_mutex);
        time_t now = GameTime::GetGameTime();
        for (auto itr = _arrows.begin(); itr != _arrows.end();)
        {
            EmbeddedArrows::RemoveExpired(itr->second, now);
            if (itr->second.empty())
                itr = _arrows.erase(itr);
            else
                ++itr;
        }
    }

    bool ShouldRecoverArrow() const
    {
        std::lock_guard<std::mutex> lock(_mutex);
        return EmbeddedArrows::RecoveryRollSucceeds(_config.RecoveryChance, urand(0, 99));
    }

    void ScheduleExpiration(Player* victim, EmbeddedArrows::ArrowRecord const& record)
    {
        time_t now = GameTime::GetGameTime();
        if (record.ExpiresAt <= now)
        {
            ExpireArrow(victim, record.Id);
            return;
        }

        victim->m_Events.AddEventAtOffset([victim, arrowId = record.Id]()
        {
            Instance().ExpireArrow(victim, arrowId);
        }, Seconds(record.ExpiresAt - now));
    }

    static void SyncVisual(Player* player, ArrowStateSnapshot const& state)
    {
        if (!state.Count)
        {
            player->RemoveAurasDueToSpell(SPELL_ARROWS_IN_CHEST);
            return;
        }

        Aura* aura = player->GetAura(SPELL_ARROWS_IN_CHEST);
        if (!aura)
        {
            player->CastSpell(player, SPELL_ARROWS_IN_CHEST, true);
            aura = player->GetAura(SPELL_ARROWS_IN_CHEST);
        }

        if (!aura)
            return;

        int32 remainingDuration = int32(std::max<time_t>(1, state.LatestExpiration - GameTime::GetGameTime()) * IN_MILLISECONDS);
        aura->SetStackAmount(uint8(state.Count));
        aura->SetMaxDuration(remainingDuration);
        aura->SetDuration(remainingDuration);
    }

private:
    static uint32 BoundConfigValue(char const* key, uint32 defaultValue, uint32 minimum, uint32 maximum)
    {
        int32 configuredValue = sConfigMgr->GetIntDefault(key, int32(defaultValue));
        return uint32(std::clamp(configuredValue, int32(minimum), int32(maximum)));
    }

    static ArrowStateSnapshot MakeSnapshot(std::vector<EmbeddedArrows::ArrowRecord> const& arrows)
    {
        return { uint32(arrows.size()), EmbeddedArrows::LatestExpiration(arrows) };
    }

    mutable std::mutex _mutex;
    EmbeddedArrowConfig _config;
    std::map<uint32, std::vector<EmbeddedArrows::ArrowRecord>> _arrows;
    uint64 _nextArrowId = 1;
};

struct ArrowBodyOffset
{
    float Forward;
    float Side;
    float Height;
    float Yaw;
};

constexpr std::array<ArrowBodyOffset, 8> ArrowBodyOffsets =
{{
    {  0.10f, -0.22f, 0.45f, -0.18f },
    {  0.04f,  0.18f, 0.55f,  0.12f },
    { -0.12f, -0.10f, 0.65f, -0.06f },
    {  0.18f,  0.08f, 0.75f,  0.22f },
    { -0.20f,  0.20f, 0.85f, -0.14f },
    {  0.22f, -0.16f, 0.95f,  0.08f },
    { -0.05f,  0.04f, 1.05f, -0.24f },
    {  0.08f, -0.02f, 1.15f,  0.18f }
}};

GameObject* SpawnRecoverableArrow(Player* victim, EmbeddedArrows::ArrowRecord const& record, uint32 slot)
{
    time_t now = GameTime::GetGameTime();
    if (record.ExpiresAt <= now || !EmbeddedArrowManager::Instance().ShouldRecoverArrow())
        return nullptr;

    Map* map = victim->GetMap();
    if (!map || !sObjectMgr->GetGameObjectTemplate(GO_RECOVERABLE_ARROW))
        return nullptr;

    ArrowBodyOffset const& offset = ArrowBodyOffsets[slot % ArrowBodyOffsets.size()];
    float orientation = victim->GetOrientation() + offset.Yaw;
    float cosOrientation = std::cos(victim->GetOrientation());
    float sinOrientation = std::sin(victim->GetOrientation());
    float x = victim->GetPositionX() + offset.Forward * cosOrientation - offset.Side * sinOrientation;
    float y = victim->GetPositionY() + offset.Forward * sinOrientation + offset.Side * cosOrientation;
    float z = victim->GetPositionZ() + offset.Height * std::max(1.0f, victim->GetCollisionHeight());
    Position position(x, y, z, orientation);
    QuaternionData rotation = QuaternionData::fromEulerAnglesZYX(orientation, float(M_PI) * 0.5f, 0.0f);

    GameObject* arrow = new GameObject();
    if (!arrow->Create(map->GenerateLowGuid<HighGuid::GameObject>(), GO_RECOVERABLE_ARROW, map,
        victim->GetPhaseMask(), position, rotation, 255, GO_STATE_READY))
    {
        delete arrow;
        return nullptr;
    }

    arrow->SetSpawnedByDefault(false);
    ObjectGuid shooterGuid = ObjectGuid::Create<HighGuid::Player>(record.ShooterGuid);
    arrow->SetPrivateObjectOwner(shooterGuid);
    arrow->SetRespawnTime(int32(record.ExpiresAt - now));
    if (!arrow->AI())
    {
        delete arrow;
        return nullptr;
    }

    arrow->AI()->SetGUID(shooterGuid, DATA_ARROW_OWNER);
    arrow->AI()->SetData(DATA_ARROW_ITEM, record.ItemId);
    arrow->AI()->SetData(DATA_ARROW_EXPIRATION, uint32(record.ExpiresAt));

    if (!map->AddToMap(arrow))
    {
        delete arrow;
        return nullptr;
    }

    arrow->EnableCollision(false);
    return arrow;
}

void HandlePlayerDeath(Player* player)
{
    player->RemoveAurasDueToSpell(SPELL_ARROWS_IN_CHEST);
    std::vector<EmbeddedArrows::ArrowRecord> arrows = EmbeddedArrowManager::Instance().TakeArrows(player);

    uint32 spawnedArrows = 0;
    for (EmbeddedArrows::ArrowRecord const& arrow : arrows)
        if (SpawnRecoverableArrow(player, arrow, spawnedArrows))
            ++spawnedArrows;
}

class embedded_arrow_world_script : public WorldScript
{
public:
    embedded_arrow_world_script() : WorldScript("embedded_arrow_world_script") { }

    void OnConfigLoad(bool /*reload*/) override
    {
        EmbeddedArrowManager::Instance().LoadConfig();
    }

    void OnStartup() override
    {
        if (!sSpellMgr->GetSpellInfo(SPELL_ARROWS_IN_CHEST))
            TC_LOG_ERROR("scripts", "EmbeddedArrows: visual spell {} does not exist.", SPELL_ARROWS_IN_CHEST);

        if (!sObjectMgr->GetGameObjectTemplate(GO_RECOVERABLE_ARROW))
            TC_LOG_ERROR("scripts", "EmbeddedArrows: gameobject template {} does not exist; recovery objects cannot spawn.", GO_RECOVERABLE_ARROW);
    }

    void OnUpdate(uint32 diff) override
    {
        _pruneTimer += diff;
        if (_pruneTimer < MINUTE * IN_MILLISECONDS)
            return;

        _pruneTimer = 0;
        EmbeddedArrowManager::Instance().PruneExpired();
    }

private:
    uint32 _pruneTimer = 0;
};

class embedded_arrow_player_script : public PlayerScript
{
public:
    embedded_arrow_player_script() : PlayerScript("embedded_arrow_player_script") { }

    void OnSpellDamage(Player* player, Unit* victim, Spell* spell, uint32 damage) override
    {
        if (!player || !victim || !spell)
            return;

        Player* playerVictim = victim->ToPlayer();
        if (player->GetClass() != CLASS_HUNTER || !playerVictim || !EmbeddedArrowManager::Instance().IsEnabled())
            return;

        uint32 ammoItemId = spell->GetAmmoItemId();
        ItemTemplate const* ammoTemplate = sObjectMgr->GetItemTemplate(ammoItemId);
        SpellInfo const* spellInfo = spell->GetSpellInfo();

        EmbeddedArrows::HitContext context;
        context.FeatureEnabled = true;
        context.AttackerIsHunter = true;
        context.VictimIsPlayer = true;
        context.RangedWeaponSpell = spellInfo && spellInfo->IsRangedWeaponSpell();
        context.RequiresAmmo = spellInfo && spellInfo->HasAttribute(SPELL_ATTR0_REQ_AMMO);
        context.ArrowProjectile = ammoTemplate && ammoTemplate->GetClass() == ITEM_CLASS_PROJECTILE &&
            ammoTemplate->GetSubClass() == ITEM_SUBCLASS_ARROW;
        context.ConfiguredAmmo = EmbeddedArrowManager::Instance().IsConfiguredAmmo(ammoItemId);
        context.Damage = damage;
        context.AmmoItemId = ammoItemId;

        if (!EmbeddedArrows::ShouldEmbed(context))
            return;

        if (spell->GetAmmoOwnerGuid() != player->GetGUID() || spell->ClaimAmmoItemForRecovery() != ammoItemId)
            return;

        std::optional<AddedArrow> addedArrow = EmbeddedArrowManager::Instance().AddArrow(playerVictim, player, ammoItemId);
        if (!addedArrow)
            return;

        if (playerVictim->IsAlive())
            EmbeddedArrowManager::SyncVisual(playerVictim, addedArrow->State);

        EmbeddedArrowManager::Instance().ScheduleExpiration(playerVictim, addedArrow->Record);
    }

    void OnPlayerDeath(Player* player) override
    {
        player->m_Events.AddEventAtOffset([player]()
        {
            if (player->IsAlive())
                EmbeddedArrowManager::Instance().RestorePlayer(player);
            else
                HandlePlayerDeath(player);
        }, Milliseconds(1));
    }

    void OnLogin(Player* player, bool /*firstLogin*/) override
    {
        EmbeddedArrowManager::Instance().RestorePlayer(player);
    }

    void OnDelete(ObjectGuid guid, uint32 /*accountId*/) override
    {
        EmbeddedArrowManager::Instance().RemovePlayer(guid);
    }
};

class go_recoverable_embedded_arrow : public GameObjectScript
{
public:
    go_recoverable_embedded_arrow() : GameObjectScript("go_recoverable_embedded_arrow") { }

    struct go_recoverable_embedded_arrowAI : public GameObjectAI
    {
        go_recoverable_embedded_arrowAI(GameObject* gameObject) : GameObjectAI(gameObject) { }

        void SetGUID(ObjectGuid const& guid, int32 id) override
        {
            if (id == DATA_ARROW_OWNER)
                _ownerGuid = guid;
        }

        void SetData(uint32 id, uint32 value) override
        {
            if (id == DATA_ARROW_ITEM)
                _itemId = value;
            else if (id == DATA_ARROW_EXPIRATION)
                _expiresAt = value;
        }

        void UpdateAI(uint32 /*diff*/) override
        {
            if (_expiresAt && GameTime::GetGameTime() >= _expiresAt)
                me->Delete();
        }

        bool OnGossipHello(Player* player) override
        {
            if (!_ownerGuid || player->GetGUID() != _ownerGuid || !_itemId ||
                (_expiresAt && GameTime::GetGameTime() >= _expiresAt))
                return true;

            ItemPosCountVec destination;
            InventoryResult result = player->CanStoreNewItem(NULL_BAG, NULL_SLOT, destination, _itemId, 1);
            if (result != EQUIP_ERR_OK)
            {
                player->SendEquipError(result, nullptr, nullptr, _itemId);
                return true;
            }

            if (Item* item = player->StoreNewItem(destination, _itemId, true))
            {
                player->SendNewItem(item, 1, true, false);
                me->Delete();
            }

            return true;
        }

    private:
        ObjectGuid _ownerGuid;
        uint32 _itemId = 0;
        time_t _expiresAt = 0;
    };

    GameObjectAI* GetAI(GameObject* gameObject) const override
    {
        return new go_recoverable_embedded_arrowAI(gameObject);
    }
};
}

void AddSC_embedded_arrows()
{
    new embedded_arrow_world_script();
    new embedded_arrow_player_script();
    new go_recoverable_embedded_arrow();
}

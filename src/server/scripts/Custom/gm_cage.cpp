#include "ScriptMgr.h"
#include "GameObject.h"
#include "Player.h"
#include "SpellAuraEffects.h"
#include "SpellScript.h"
#include "WorldSession.h"

namespace
{
enum GMCage
{
    SPELL_GM_CAGE = 90000,
    GO_ILLIDAN_CAGE_TRAP = 185916
};

void RemoveGMCage(Player* player)
{
    if (GameObject* cage = player->GetGameObject(SPELL_GM_CAGE))
    {
        // Prevent deleting the visual from recursively removing its owning aura.
        cage->SetSpellId(0);
        cage->Delete();
    }
}

void SummonGMCage(Player* player)
{
    if (!player->IsInWorld() || !player->HasAura(SPELL_GM_CAGE))
        return;

    if (GameObject* cage = player->GetGameObject(SPELL_GM_CAGE))
    {
        if (cage->IsInWorld() && cage->GetMap() == player->GetMap())
            return;

        RemoveGMCage(player);
    }

    Aura const* aura = player->GetAura(SPELL_GM_CAGE);
    int32 duration = aura ? aura->GetDuration() : 0;
    Seconds lifetime = duration > 0 ? Seconds((duration + IN_MILLISECONDS - 1) / IN_MILLISECONDS + 1) : 10min;

    if (GameObject* cage = player->SummonGameObject(GO_ILLIDAN_CAGE_TRAP, player->GetPosition(), QuaternionData(), lifetime))
    {
        cage->SetSpellId(SPELL_GM_CAGE);
        cage->SetFlag(GO_FLAG_NOT_SELECTABLE);
        cage->UseDoorOrButton(uint32(lifetime.count() * IN_MILLISECONDS), false, player);
    }
}
}

class spell_custom_gm_cage : public SpellScript
{
    PrepareSpellScript(spell_custom_gm_cage);

    SpellCastResult CheckCast()
    {
        Player* caster = GetCaster()->ToPlayer();
        Player* target = GetExplTargetUnit() ? GetExplTargetUnit()->ToPlayer() : nullptr;
        if (!caster || !caster->GetSession() || caster->GetSession()->GetSecurity() < SEC_GAMEMASTER)
            return SPELL_FAILED_CANT_DO_THAT_RIGHT_NOW;

        if (!target || target == caster)
            return SPELL_FAILED_BAD_TARGETS;

        if (target->GetSession() && caster->GetSession()->GetSecurity() <= target->GetSession()->GetSecurity())
            return SPELL_FAILED_BAD_TARGETS;

        if (target->HasAura(SPELL_GM_CAGE))
            return SPELL_FAILED_AURA_BOUNCED;

        return SPELL_CAST_OK;
    }

    void Register() override
    {
        OnCheckCast += SpellCheckCastFn(spell_custom_gm_cage::CheckCast);
    }
};

class spell_custom_gm_cage_aura : public AuraScript
{
    PrepareAuraScript(spell_custom_gm_cage_aura);

    bool Load() override
    {
        return GetUnitOwner()->GetTypeId() == TYPEID_PLAYER;
    }

    void HandleApply(AuraEffect const* /*aurEff*/, AuraEffectHandleModes /*mode*/)
    {
        SummonGMCage(GetTarget()->ToPlayer());
    }

    void HandleRemove(AuraEffect const* /*aurEff*/, AuraEffectHandleModes /*mode*/)
    {
        RemoveGMCage(GetTarget()->ToPlayer());
    }

    void Register() override
    {
        AfterEffectApply += AuraEffectApplyFn(spell_custom_gm_cage_aura::HandleApply, EFFECT_0, SPELL_AURA_MOD_STUN, AURA_EFFECT_HANDLE_REAL);
        AfterEffectRemove += AuraEffectRemoveFn(spell_custom_gm_cage_aura::HandleRemove, EFFECT_0, SPELL_AURA_MOD_STUN, AURA_EFFECT_HANDLE_REAL);
    }
};

class gm_cage_player_script : public PlayerScript
{
public:
    gm_cage_player_script() : PlayerScript("gm_cage_player_script") { }

    void OnLogin(Player* player, bool /*firstLogin*/) override
    {
        SummonGMCage(player);
    }

    void OnLogout(Player* player) override
    {
        RemoveGMCage(player);
    }

    void OnMapChanged(Player* player) override
    {
        SummonGMCage(player);
    }
};

void AddSC_gm_cage()
{
    RegisterSpellScript(spell_custom_gm_cage);
    RegisterSpellScript(spell_custom_gm_cage_aura);
    new gm_cage_player_script();
}

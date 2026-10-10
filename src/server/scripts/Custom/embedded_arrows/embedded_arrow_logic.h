/*
 * This file is part of the TrinityCore Project. See AUTHORS file for Copyright information
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the
 * Free Software Foundation; either version 2 of the License, or (at your
 * option) any later version.
 */

#ifndef TRINITYCORE_EMBEDDED_ARROW_LOGIC_H
#define TRINITYCORE_EMBEDDED_ARROW_LOGIC_H

#include <algorithm>
#include <cstdint>
#include <ctime>
#include <vector>

namespace EmbeddedArrows
{
struct HitContext
{
    bool FeatureEnabled = false;
    bool AttackerIsHunter = false;
    bool VictimIsPlayer = false;
    bool RangedWeaponSpell = false;
    bool RequiresAmmo = false;
    bool ArrowProjectile = false;
    bool ConfiguredAmmo = false;
    std::uint32_t Damage = 0;
    std::uint32_t AmmoItemId = 0;
};

constexpr bool ShouldEmbed(HitContext const& context)
{
    return context.FeatureEnabled && context.AttackerIsHunter && context.VictimIsPlayer &&
        context.RangedWeaponSpell && context.RequiresAmmo && context.ArrowProjectile &&
        context.ConfiguredAmmo && context.Damage > 0 && context.AmmoItemId != 0;
}

constexpr bool RecoveryRollSucceeds(std::uint32_t chance, std::uint32_t roll)
{
    return chance > roll;
}

struct ArrowRecord
{
    std::uint64_t Id = 0;
    std::uint32_t ShooterGuid = 0;
    std::uint32_t ItemId = 0;
    std::time_t ExpiresAt = 0;
};

inline void RemoveExpired(std::vector<ArrowRecord>& arrows, std::time_t now)
{
    arrows.erase(std::remove_if(arrows.begin(), arrows.end(), [now](ArrowRecord const& arrow)
    {
        return arrow.ExpiresAt <= now;
    }), arrows.end());
}

inline std::time_t LatestExpiration(std::vector<ArrowRecord> const& arrows)
{
    std::time_t latest = 0;
    for (ArrowRecord const& arrow : arrows)
        latest = std::max(latest, arrow.ExpiresAt);

    return latest;
}
}

#endif

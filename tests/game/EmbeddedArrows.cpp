/*
 * This file is part of the TrinityCore Project. See AUTHORS file for Copyright information
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the
 * Free Software Foundation; either version 2 of the License, or (at your
 * option) any later version.
 */

#include "tc_catch2.h"
#include "../../src/server/scripts/Custom/embedded_arrows/embedded_arrow_logic.h"

TEST_CASE("Embedded arrows: only damaging arrow hits are tracked")
{
    EmbeddedArrows::HitContext hit;
    hit.FeatureEnabled = true;
    hit.AttackerIsHunter = true;
    hit.VictimIsPlayer = true;
    hit.RangedWeaponSpell = true;
    hit.RequiresAmmo = true;
    hit.ArrowProjectile = true;
    hit.ConfiguredAmmo = true;
    hit.Damage = 100;
    hit.AmmoItemId = 41165;

    REQUIRE(EmbeddedArrows::ShouldEmbed(hit));

    SECTION("misses and full absorbs are rejected")
    {
        hit.Damage = 0;
        REQUIRE_FALSE(EmbeddedArrows::ShouldEmbed(hit));
    }

    SECTION("unconfigured ammunition is rejected")
    {
        hit.ConfiguredAmmo = false;
        REQUIRE_FALSE(EmbeddedArrows::ShouldEmbed(hit));
    }

    SECTION("bullets and non-ammunition spells are rejected")
    {
        hit.ArrowProjectile = false;
        REQUIRE_FALSE(EmbeddedArrows::ShouldEmbed(hit));
        hit.ArrowProjectile = true;
        hit.RequiresAmmo = false;
        REQUIRE_FALSE(EmbeddedArrows::ShouldEmbed(hit));
    }

    SECTION("non-hunters and non-player targets are rejected")
    {
        hit.AttackerIsHunter = false;
        REQUIRE_FALSE(EmbeddedArrows::ShouldEmbed(hit));
        hit.AttackerIsHunter = true;
        hit.VictimIsPlayer = false;
        REQUIRE_FALSE(EmbeddedArrows::ShouldEmbed(hit));
    }
}

TEST_CASE("Embedded arrows: records expire independently")
{
    std::vector<EmbeddedArrows::ArrowRecord> arrows =
    {
        { 1, 10, 41165, 100 },
        { 2, 10, 41165, 101 },
        { 3, 11, 52021, 200 }
    };

    EmbeddedArrows::RemoveExpired(arrows, 101);

    REQUIRE(arrows.size() == 1);
    REQUIRE(arrows.front().Id == 3);
    REQUIRE(EmbeddedArrows::LatestExpiration(arrows) == 200);
}

TEST_CASE("Embedded arrows: recovery chance honors boundaries")
{
    REQUIRE_FALSE(EmbeddedArrows::RecoveryRollSucceeds(0, 0));
    REQUIRE(EmbeddedArrows::RecoveryRollSucceeds(100, 99));
    REQUIRE(EmbeddedArrows::RecoveryRollSucceeds(50, 49));
    REQUIRE_FALSE(EmbeddedArrows::RecoveryRollSucceeds(50, 50));
}

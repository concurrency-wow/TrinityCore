DELETE FROM `spell_dbc` WHERE `Id` = 90000;
INSERT INTO `spell_dbc`
(`Id`, `Dispel`, `Mechanic`, `Attributes`, `AttributesEx`, `AttributesEx2`, `AttributesEx3`, `AttributesEx4`, `CastingTimeIndex`, `ProcChance`, `DurationIndex`, `RangeIndex`, `Effect1`, `EffectDieSides1`, `EffectImplicitTargetA1`, `EffectApplyAuraName1`, `SpellName`, `MaxAffectedTargets`, `DmgMultiplier1`, `DmgMultiplier2`, `DmgMultiplier3`, `SchoolMask`) VALUES
(90000, 0, 0, 2751463424, 1152, 67108864, 1442048, 1, 1, 101, 6, 6, 6, 1, 25, 12, 'GM Cage', 1, 1, 1, 1, 1);

DELETE FROM `spell_script_names` WHERE `ScriptName` IN ('spell_custom_gm_cage', 'spell_custom_gm_cage_aura');
INSERT INTO `spell_script_names` (`spell_id`, `ScriptName`) VALUES
(90000, 'spell_custom_gm_cage'),
(90000, 'spell_custom_gm_cage_aura');

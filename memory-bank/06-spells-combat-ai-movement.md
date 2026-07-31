# Spells, Combat, AI, Vehicles, and Movement

## Scope and layer boundaries

Primary code is under `src/server/game/Spells/`, `Combat/`, `AI/`, `Movement/`,
`Entities/Unit/`, `Entities/Vehicle/`, and
`src/common/Collision/Management/`.

| Layer | Role | Typical source |
|---|---|---|
| Core engine | Generic spell, aura, combat, threat, AI, and movement | `src/server/game/` |
| C++ scripts | Spell-, creature-, encounter-, and zone-specific behavior | `src/server/scripts/` |
| SmartAI | DB event/action behavior for creatures/gameobjects | World `smart_scripts` |

SmartAI can request a cast but does not replace spell/aura/proc/damage or
movement internals. A core effect change affects every spell using it; prefer
data or a script when behavior is not genuinely generic.

These layers normally execute synchronously in the owning map update. Hooks
inherit the thread and lifetime constraints of their call site.

## Unit update ordering

```text
Map::Update()
  -> Creature::Update()
       -> Unit::Update()
          -> WorldObject::Update()
             -> EventProcessor::Update() / SpellEvent
          -> _UpdateSpells()
             -> clear finished current-spell pointers
             -> update owned auras
             -> expire and delete deferred aura removals
          -> CombatManager::Update()
          -> attack/reactive timers
          -> UpdateSplineMovement()
          -> MotionMaster::Update()
          -> deferred charm-AI replacement
       -> Unit::AIUpdateTick()
          -> UnitAI::UpdateAI()
```

See `Entities/Object/Object.cpp::WorldObject::Update()`,
`Entities/Unit/Unit.cpp::Unit::Update()`, and
`Entities/Creature/Creature.cpp::Creature::Update()`.

Spell events must run before `_UpdateSpells()` or finished spells can remain
in current-spell slots. Spline interpolation advances before movement policy;
AI runs after spell, combat, and movement state for the tick.

## Spell data assembly

`SpellMgr::LoadSpellInfoStore()` constructs `SpellInfo` from `Spell.dbc`.
Startup then applies hard-coded fixes, SQL attributes, and derived caches.

| Data | Loader |
|---|---|
| Rank chains | `LoadSpellRanks()` |
| Groups and stacking | `LoadSpellGroups()`, `LoadSpellGroupStackRules()` |
| Proc definitions | `LoadSpellProcs()` |
| Bonus coefficients | `LoadSpellBonuses()` |
| Threat overrides | `LoadSpellThreats()` |
| Target positions | `LoadSpellTargetPositions()` |
| Linked spells | `LoadSpellLinked()` |
| Area requirements | `LoadSpellAreas()` |
| Server attributes | `LoadSpellInfoCustomAttributes()` |

Spell behavior combines DBC, the `spell_dbc` overlay, world tables,
hard-coded corrections, derived caches, and scripts. Follow
`World::SetInitialWorldSettings()` to understand precedence.

### Spell script bindings

`ObjectMgr::LoadSpellScriptNames()` loads `spell_script_names`. A negative ID
binds every rank but must name the first rank; a positive ranked ID binds only
that rank and warns about likely missing ranks.

```text
LoadSpellScriptNames()
  -> ScriptMgr::Initialize()
  -> ObjectMgr::ValidateSpellScripts()
  -> SmartAIMgr::LoadSmartAIFromDB()
```

Validation creates temporary script objects, registers hooks, calls script
validation, and disables invalid bindings. Runtime
`CreateSpellScripts()`/`CreateAuraScripts()` creates fresh objects per spell or
aura.

## Spell state machine

`CMSG_CAST_SPELL` is map-side. `HandleCastSpellOpcode()` in
`Handlers/SpellHandler.cpp` resolves `SpellInfo`, rejects passive spells,
parses targets, verifies known spell/rank and movement data, creates `Spell`,
then calls `prepare()`.

States in `Spells/Spell.h` are `NULL`, `PREPARING`, `CASTING`, `FINISHED`,
`IDLE`, and `DELAYED`.

```text
HandleCastSpellOpcode()
  -> Spell::prepare()
       -> explicit targets and PREPARING
       -> SpellEvent in caster.m_Events
       -> per-cast scripts
       -> cost and initial CheckCast()
       -> cast time, current spell, GCD, start packet
  -> SpellEvent::Execute()
       -> Spell::update()
       -> Spell::cast()
          -> re-resolve GUID-backed pointers
          -> final CheckCast() where required
          -> SelectSpellTargets()
          -> script before/on-cast hooks
          -> consume power/reagents
          -> launch/hit processing
          -> delayed projectile/channel state
  -> Spell::finish() or Spell::cancel()
```

Validation repeats because range, immunity, movement, trade, object, and target
state can change during cast or travel. Handler checks are not hit-time
authorization.

Power and reagents are removed before effects. Reagents precede effects so an
item-creation effect can use the freed slot. `cancel()` handles preparing,
delayed, and channel state differently, including GCD, interruption packets,
channel auras, dynamic objects, and current-spell slots.

## Spell ownership and delayed execution

`Spell::prepare()` creates `SpellEvent`, which owns the spell through
`Trinity::unique_trackable_ptr<Spell>`. Current-spell slots and script
references are non-owning. Do not stack-allocate or delete a spell after
handing it to `prepare()`.

`EventProcessor` owns raw `BasicEvent*` entries:

- `Execute() == true` deletes the event.
- `false` prevents deletion but does not automatically requeue it.
- Scheduled abort calls `Abort()` later.
- Forced destruction aborts/deletes remaining events.

`SpellEvent` explicitly re-adds itself and schedules projectile hit moments.
Its destructor cancels unfinished spells and asserts on non-deletable state.

Summon-player effects use `Map::AddFarSpellCallback()` after the map barrier
and recheck target/immunity. This is a narrow engine path, not a general
cross-map mutation API.

## Targets and effects

`Spell::SelectSpellTargets()` builds unique unit, gameobject, item, corpse, and
destination targets from explicit/implicit DBC rules. Selection hooks can
replace or filter them.

Effects have launch, launch-target, hit, and hit-target modes.
`Spell::HandleEffects()` calculates value, invokes script effect hooks, then
calls `SpellEffectHandlers[]` unless a script prevents default handling.

- Scripts can augment or suppress default effects.
- A default-handler change affects every spell with that effect enum.
- Hook-selected objects must be legal for the effect/current map.
- Earlier hooks can mutate targets, caster, auras, or the cast itself.
- Delayed targets are re-resolved by GUID; do not retain selection pointers.

## Aura model

| Object | Meaning |
|---|---|
| `Aura` | Owned aura with duration, stacks, charges, and proc state |
| `AuraEffect` | One effect slot |
| `AuraApplication` | Application to one target, effect mask, visible slot |

An owner can be `Unit` or `DynamicObject`. A unit distinguishes owned auras,
applied applications, and deferred removed auras. A self aura often appears in
both owned/applied structures, but they are not interchangeable.

`Aura::_ApplyForTarget()` registers application; target `_ApplyAura()` applies
effects. Removal unapplies effects and links, then defers physical deletion
until iteration is safe. `_Remove()` empties applications, aborts its drop
event, and invalidates its script reference.

Never retain aura/effect/application pointers across operations that can
remove, dispel, expire, transfer, or replace the aura.

### Area and periodic auras

`Aura::UpdateOwner()` updates duration/cost, refreshes target maps every
`UPDATE_TARGET_MAP_INTERVAL` (500 ms), updates effects, and deletes deferred
applications.

Area refresh rebuilds eligible targets, rechecks immunity/stacking, updates
masks, adds applications, and removes stale ones.

`AuraEffect::Update()` accumulates elapsed time and loops over all elapsed
periods. One long map tick can produce multiple periodic ticks. Hooks can
prevent an individual tick's default processing.

## Proc pipeline

```text
Unit::ProcSkillsAndAuras()
  -> GetProcAurasTriggeredOnEvent()
       -> Aura::GetProcEffectMask()
          -> DB rules, conditions, script checks, chance
       -> Aura::PrepareProcToTrigger()
          -> script prepare hook
          -> consume charge
          -> start aura cooldown
  -> TriggerAurasProcOnEvent()
       -> skip removing applications
       -> Aura::TriggerProcOnEvent()
          -> script hook, effect handlers, after hooks
          -> remove final-charge aura
```

The list is prepared before execution because procs mutate aura collections.
Actor and action-target lists are separate; applied spell-mod auras can also
participate. Charges/cooldowns change before effect handlers, so suppressing a
later default proc does not restore them automatically.

`Unit::Update()` asserts proc suppression is balanced. Every
`SetCantProc(true)` path must restore it.

## Combat, damage, death

`CombatManager` is the authority for combat. A unit is in combat iff it has at
least one non-suppressed `CombatReference`.

`CanBeginCombat()` requires distinct live in-world units, same map/phase,
neither evading/in-flight, combat permitted, hostility, and no GM participant.
A reference belongs to both managers. Ending it clears threat and both links,
updates flags, notifies AI, then deletes the shared relation.

Do not conflate:

| Structure | Meaning |
|---|---|
| `CombatReference` | Symmetric combat relation |
| `ThreatReference` | Creature target-selection relation |
| `m_attacking` / `m_attackers` | Current melee links |
| Spell targets | One cast's selection |

### Melee path

```text
Unit::Attack()
  -> victim/attacker links
  -> AttackerStateUpdate()
       -> CalculateMeleeDamage()
          -> hit, armor, block, resist, absorb, crit/glance/crush, hooks
       -> DealMeleeDamage()
          -> log and procs
          -> DealDamage()
             -> victim/attacker AI hooks and ScriptMgr::OnDamage
             -> interrupts, sharing, rage, duel rules
             -> health reduction or Kill()
```

Hooks receive mutable damage before lethal resolution and can change outcome.
They can also trigger reentrant casts/despawns; revalidate after calls.

`DealDamage()` also handles interrupt/absorb/shared damage, rage, duel
prevention, battleground/achievement state, combat/loot tap, durability, and
player death rules.

`Kill()` prevents duplicate rewards, verifies map relation, determines
controlling player/loot recipient, generates loot, grants rewards, and runs
kill procs/hooks.

`setDeathState()` sets death first to prevent cleanup reentry, then stops
combat/casts, exits vehicles, removes controlled units/totems/death-sensitive
auras, clears reactive/diminishing state, stops movement, updates health/power,
and invokes zone/instance hooks. Ordering is an invariant.

## Threat

`ThreatManager` maintains bidirectional `ThreatReference`s. References can be
available, offline, suppressed, taunting, or fixated. It handles spell/school
modifiers, assistance, redirects, taunts/fixates, target states, heap ordering,
and AI notification.

Victim reselection keeps current victim unless another available target has
over 110% threat in melee range or over 130% regardless of range. A fixated
target wins first. If a ranged top target is between thresholds, lower heap
entries are checked for a qualifying melee target.

Directly editing threat bypasses heap, reverse links, combat, redirect, and AI
bookkeeping. Use `ThreatManager` APIs.

## AI layers and selection

`FactorySelector::SelectAI()` uses:

1. `PetAI` for pets.
2. C++ creature script selected through `ScriptMgr`.
3. Template `AIName`.
4. Registered core factory with highest non-negative permit.

A valid C++ `ScriptName` takes precedence over `AIName`; do not configure it
with SmartAI expecting both. Core AI changes should be reusable engine policy.

### C++ scripted AI

`ScriptedAI`/`BossAI` in `AI/ScriptedAI/ScriptedCreature.*` provide cast,
target, threat, movement, summon, event, and instance helpers. `BossAI` owns an
`InstanceScript`, `EventMap`, `SummonList`, and `TaskScheduler`, and coordinates
encounter state/boundaries.

Base `BossAI::UpdateAI()` polls `EventMap`, not `TaskScheduler`. Derived AI
using `scheduler` must call `scheduler.Update(...)` itself. Registration needs
a matching world `ScriptName`; new files require CMake reconfiguration.

### SmartAI

SmartAI under `AI/SmartScripts/` uses `AIName='SmartAI'` for creatures,
`SmartGameObjectAI` for gameobjects, and rows in `smart_scripts` plus optional
waypoint/text/condition/action-list data.

`SmartAIMgr::LoadSmartAIFromDB()` validates source, template/spawn, AI name,
parameters, spells, creatures, gameobjects, quests, and references. Positive
`entryorguid` normally targets templates; negative targets supported spawns.

`SmartScript::OnUpdate()` installs/sorts pending events, updates timers/stored
events/action lists, then performs actions. Nested dispatch has a recursion
limit. Snapshot note: an empty-result log says `smartai_scripts`, while query
and schema use `smart_scripts`.

Use SmartAI for supported event/action composition and C++ for custom state
machines, cross-object coordination, or unavailable hooks.

## AI update safety

`Unit` stores a stack of `std::shared_ptr<UnitAI>` and exposes the active top.
`AIUpdateTick()` locks AI around `UpdateAI()`; `RefreshAI()` asserts while
locked. Charm replacement uses `ScheduleAIChange()` and resolves later in
`Unit::Update()`.

AI callbacks can cause death, evade, charm, despawn, cast, and movement
replacement. Recheck world/life/victim/active AI, clear timers/tasks/summons
on lifecycle transitions, and keep GUIDs rather than delayed target pointers.

## Timing facilities

| Facility | Ownership/use |
|---|---|
| `EventMap` | Diff-driven IDs, groups, and phases |
| `TaskScheduler` | Callable tasks, groups, validators, repeats, cancellation |
| `EventProcessor` | Object-owned polymorphic events |

### EventMap

`EventMap` stores a `multimap<TimePoint, Event>`. Group/phase masks are 8-bit,
so indexes are 1-8; zero means none/unrestricted. A due event excluded by the
active phase is erased, not postponed. `Repeat()` reuses the last executed
event's ID/group/phase and must follow successful `ExecuteEvent()`.

`Update()` only advances time; callers must drain due events. `Reset()` clears
events, time, and phases.

### TaskScheduler

`TaskScheduler` supports steady or synthetic time, groups, validators,
cancellation, delay, reschedule, repeat, and `Async()`.

`TaskContext::Schedule()` is relative to the previous task's planned end; an
already-due chain can execute in the same dispatch. Use `Async()` for explicit
next-update behavior. `Repeat()` consumes its context and asserts if repeated
twice. A failed validator stops dispatch but may retain due tasks.

Its weak self-reference detects scheduler destruction but does not make
captured pointers safe. Capture GUIDs/weak references and cancel owner tasks.

## Movement architecture

| Layer | Responsibility |
|---|---|
| `MotionMaster` | Owns default/active generators and priority |
| `MovementGenerator` | Chooses destinations and completion |
| `PathGenerator` | Builds a navigation path synchronously |
| `MoveSplineInit` | Builds/launches spline parameters |
| `MoveSpline` | Interpolates active path |
| `Unit::UpdateSplineMovement()` | Advances and applies position |

Do not bypass layers unless intentionally replacing their bookkeeping.

### MotionMaster

`MotionMaster` owns one default and priority-sorted active generators. Higher
numeric priority wins; adding a non-immediate generator at an occupied priority
replaces the existing one.

Lifecycle is initialize, reset/resume, update, deactivate, and finalize. Base
unit states are reference-counted among generators.

Structural changes requested during `MotionMaster::Update()` are deferred
until the active generator returns. Natural completion (`Update() == false`)
usually sends `MovementInform`; explicit removal/clear generally does not.
Test both arrival and interruption.

Chase, follow, waypoint, point, flight, confused, fleeing, assistance, jump,
charge, and spline generators are policies, not spline types.

### Pathfinding

`PathGenerator` returns flags including normal, shortcut, incomplete, no path,
not-using-path, short, and far-from-poly endpoints. Boolean success does not
mean a complete normal route; inspect `GetPathType()` and actual endpoint.

`MoveSplineInit::MoveTo(generatePath=true)` accepts calculated paths not marked
`NOPATH`; otherwise it falls back to a direct two-point spline that can cross
obstacles. Fail-closed behavior must calculate and inspect explicitly.

`MMapManager` shares `dtNavMesh` per map and keeps one `dtNavMeshQuery` per map
instance because queries are not thread-safe. The query still belongs to its
normal map execution context. Pathfinding is synchronous and can extend a
tick; do not recalculate more often than needed.

### Splines and relocation

`MoveSplineInit::Launch()` calculates current interpolated position, handles
transport-local/world coordinates, selects flags/speed, initializes the unit's
spline, and sends movement. `Unit::UpdateSplineMovement()` advances it and
applies server position.

A spline is trajectory only; its generator owns policy, recalculation,
completion, and notification. Updating only packets or server coordinates
desynchronizes state.

Test missing/incomplete/shortcut paths, moving targets, speed changes, control
states/death, transport coordinates, and priority interruption.

## Vehicles

A unit `Vehicle` in `Entities/Vehicle/Vehicle.*` is a `TransportBase` attached
as `Unit::m_vehicleKit`; passengers point through `Unit::m_vehicle`. It is
distinct from route-based map `Transport`.

| Data | Source |
|---|---|
| Vehicle capabilities | `Vehicle.dbc` |
| Seat flags/offsets | `VehicleSeat.dbc` |
| Core settings | `vehicle_template` |
| Seat orientation/exit | `vehicle_seat_addon` |
| Template accessories | `vehicle_template_accessory` |
| Spawn accessories | `vehicle_accessory` |
| Click boarding | `npc_spellclick_spells` |

ObjectMgr vehicle loaders validate SQL against templates, spell-click data,
and DBC seats. Seat flags control entry/exit, selectability, pets, and control.

### Boarding protocol

```text
Unit::EnterVehicle()
  -> cast VEHICLE_SPELL_RIDE_HARDCODED
  -> SPELL_AURA_CONTROL_VEHICLE on vehicle base
  -> AuraEffect::HandleAuraControlVehicle()
  -> Unit::_EnterVehicle()
  -> Vehicle::AddPassenger()
       -> reserve seat with VehicleJoinEvent
  -> passenger EventProcessor
       -> VehicleJoinEvent::Execute()
          -> revalidate aura/passenger/vehicle/seat
          -> set offsets and seat
          -> optional CHARM_TYPE_VEHICLE
          -> boarding spline and hooks
```

The delayed event exists because selecting a seat may eject a prior passenger
or uninstall the vehicle. Pending events reserve seats and must be canceled
when aura, vehicle, or passenger disappears.

Use `EnterVehicle()` or the ride spell, not direct pointer/seat/charm/movement
field mutation.

`ChangeSeat()` changes the existing control-aura effect amount (`seat + 1`),
whose amount-change handler removes old placement and enters the new seat. A
passenger must retain exactly one matching control aura on the base.

Exit removes that aura. Unapply cancels joins, distinguishes full exit from
seat/proxy changes, removes passenger/control state, restores movement/fall,
chooses exit coordinates, and launches exit movement. Death exits passengers
before general controlled-unit cleanup.

Accessory installation creates configured creature passengers. Uninstall must
cancel joins, remove passengers/accessories/control, and invalidate the kit.
Boarding is rejected during `STATUS_UNINSTALLING`.

Vehicle relocation transforms seat-local offsets. Nested vehicles and vehicles
on map transports require all coordinate layers:

```text
seat offset -> vehicle coordinates -> optional map-transport offset -> world
```

Test boarding, replacement, control seats, accessories, death, aura dispel,
teleport, logout, nesting, and vehicle-on-transport behavior.

## Script module lifetime

Typed `ScriptRegistry` objects in `Scripting/ScriptMgr.*` own registered
scripts. Creature scripts use world `ScriptName`; spell scripts additionally
need `spell_script_names`.

With `TRINITY_API_USE_DYNAMIC_LINKING`, `ScriptReloadMgr::Update()` applies
queued module changes from the world loop. `ModuleReference` keeps old modules
loaded while live spell/aura/instance scripts reference them. Reload does not
immediately unload every old image. Static builds do not hot-swap modules.

## Safe workflows

### Spell or aura

1. Decide generic core vs DBC/SQL vs one-spell script.
2. Trace all ranks/difficulties and existing corrections/attributes/procs.
3. Add script registration and `Validate()` where possible.
4. Bind exact IDs; use negative first rank only for every-rank behavior.
5. Reconfigure CMake for new files and inspect startup validation.
6. Test initial/cast/hit failure, cancel, interrupt, reflect, immune, delayed,
   channel, and disappearing target.

### Creature behavior

Choose exactly one primary AI, match `ScriptName`/`AIName`, reset events/tasks/
summons/state on lifecycle transitions, re-resolve delayed targets, respect AI
locking, and test charm, evade, leash, death, respawn, unload, and reset.

### Combat or threat

Keep combat/attack/threat/spell/aura structures separate, preserve reverse
links, place hooks deliberately around mitigation, handle absorb/zero/duel/
immune/shared damage, test owners (player/pet/vehicle/creature), and verify one
reward/death path and coherent combat exit.

### Timing

Choose the facility by ownership; define reset/cancel/destruction; decide phase
discard vs defer; avoid delayed raw pointers; test long diffs, self-scheduling,
reset inside callback, and owner removal.

### Movement

Use an existing generator/priority, define interruption/finalization, inspect
path flags, use spline and relocation APIs, preserve transport coordinates,
test with/without mmaps and multiple map workers, and verify server/client/
`MovementInform()` agreement.

### Vehicle

Verify DBC and all SQL, enter through control aura, use seat APIs, handle join
cancellation and aura exit, preserve charm/offsets, and test control transfer,
nesting, transports, death, uninstall, and logout.

## Validation and hazards

Test all cast sources/ranks/difficulties, changing targets and map state,
multi-target aura lifecycle, lag catch-up ticks, proc charges/cooldowns,
combat suppression/PvP timeout, threat thresholds/taunts/redirects, AI reset/
charm/summons, SmartAI validation, timing phases/validators, movement natural
and interrupted completion, path modes, vehicles, and map workers off/on.

Useful logs include `spells`, `scripts`, `scripts.ai`, `entities.unit`,
`entities.unit.ai`, `entities.vehicle`, `movement.motionmaster`, `maps`,
`sql.sql`, and `server.loading`.

High-risk invariants:

- Core effect changes are global; handler validation does not replace later
  checks.
- `SpellEvent` owns prepared spells; event `false` does not auto-requeue.
- Hooks can invalidate objects/containers being iterated.
- Area auras refresh at 500 ms; periodic effects can catch up multiple ticks.
- Proc charges/cooldowns prepare before effects.
- Combat, threat, and attack links are distinct.
- AI hooks can alter lethal outcome; death order protects cleanup.
- AI replacement during update asserts; schedule it.
- C++ `ScriptName` outranks `AIName`; pets force `PetAI`.
- `EventMap` discards phase-mismatched due events and repeats last metadata.
- Task chains can run in one dispatch; scheduler ownership does not protect
  captured pointers.
- Base `BossAI::UpdateAI()` does not poll its scheduler.
- Motion changes during update are deferred; occupied priority replaces.
- Explicit movement removal usually lacks natural completion notification.
- Path success may be incomplete/shortcut; MoveTo can fall back direct.
- Detour queries are per-instance and non-thread-safe.
- Vehicle boarding is aura plus delayed event, not a pointer assignment.
- Direct seat/transport mutation breaks aura, charm, visibility, and movement.
- Runtime script hotswap exists only in dynamic-linking builds.

# Scripting and Administrative Commands

## Systems and execution boundary

| Layer | Purpose | Primary implementation |
|---|---|---|
| C++ script objects | Hooks, custom AI, instances, spells, commands | `src/server/game/Scripting/`, `src/server/scripts/` |
| SmartAI | Data-driven creature/gameobject/area-trigger behavior | `src/server/game/AI/SmartScripts/`, `smart_scripts` |
| Legacy DB scripts | Delayed event/waypoint command rows | `event_scripts`, `waypoint_scripts` |
| Chat commands | Typed parsing, help, permission, execution | `src/server/game/Chat/ChatCommands/` |
| RBAC | Account permissions and linked roles | `src/server/game/Accounts/`, auth DB |

These systems share data but are not interchangeable. `ScriptSystem` in
`Scripting/ScriptSystem.*` owns spline-chain data; it is not the C++ registry.

`ScriptMgr` invokes synchronously and does not marshal to a safe thread. World
hooks usually run in the world loop; entity/instance/spell hooks on a map;
socket hooks can run on network threads; packet hooks inherit opcode context;
administrative commands run on the world thread. Different maps can call the
same globally registered script concurrently. Avoid unprotected global state.

## C++ registration

`ScriptObject` categories in `Scripting/ScriptMgr.h` include:

- `ServerScript`, `WorldScript`, `PlayerScript`, `AccountScript`
- `CreatureScript`, `GameObjectScript`, `AreaTriggerScript`
- `InstanceMapScript`, `WorldMapScript`, `BattlegroundMapScript`
- `SpellScriptLoader`, `ItemScript`, `ConditionScript`
- `CommandScript`, `VehicleScript`, `TransportScript`, `WeatherScript`

Constructors register into typed `ScriptRegistry<T>`. Registries own accepted
objects with `unique_ptr`, hence the normal `new example_script()` in
`AddSC_*`. Do not stack-allocate or separately own a registered script.

| Registry | Key |
|---|---|
| Database-bound | Numeric script ID resolved from exact world DB name |
| Code-only | Current static/dynamic module context |

Creature, gameobject, instance, spell, item, and area-trigger categories are
DB-bound. World, player, account, command, unit, and server categories are
code-only.

DB-bound registration requires `ObjectMgr::GetScriptId(name)` to find a name
loaded from world data. Unreferenced C++ objects are rejected/logged; DB names
without a registered object are reported after initialization. Duplicate names
abort. Names are globally unique, exact, and case-sensitive for coupling.

Code-only registries use unordered context storage; iteration order is not a
hook-order contract.

## Startup order and script IDs

```text
ObjectMgr::LoadScriptNames()
  -> templates/spawns/instances/area triggers resolve IDs
  -> LoadEventScripts()
  -> LoadWaypointScripts()
  -> LoadSpellScriptNames()
  -> ScriptMgr::Initialize()
       -> spline data, core SmartAI bridge/LFG scripts
       -> generated static AddScripts()
       -> dynamic modules
       -> registry context swap
       -> report unused DB names
  -> ScriptMgr::OnConfigLoad(false)
  -> ObjectMgr::ValidateSpellScripts()
  -> SmartAIMgr::LoadSmartAIFromDB()
```

`LoadScriptNames()` inserts empty ID zero, unions names from script-bearing
tables, sorts them, and derives numeric IDs from vector positions. Adding a
name can shift later IDs. Persist names, never generated IDs.

Sources include creature/gameobject templates and spawns, items, instances,
area triggers, spell bindings, transports, weather, conditions, OutdoorPvP,
battlefields/battlegrounds, and scripted achievements.

There is no normal runtime rebuild of the complete name store. A new DB name
generally requires restart even if the binary module is reloadable.

## Principal bindings

| Behavior | Binding |
|---|---|
| Creature | `creature_template.ScriptName` or spawn `creature.ScriptName` |
| Gameobject | `gameobject_template.ScriptName` or spawn override |
| Instance | `instance_template.script` |
| Area trigger | `areatrigger_scripts.ScriptName` |
| Spell/aura | `spell_script_names.ScriptName` |
| Item | `item_template.ScriptName` |
| Transport | `transports.ScriptName` |
| Weather | `game_weather.ScriptName` |
| Condition | `conditions.ScriptName` |

A nonzero spawn script ID overrides the template; empty falls back.

`LoadAreaTriggerScripts()` rejects IDs absent from `AreaTrigger.dbc`. Client
handling validates ID/radius, evaluates client-trigger conditions, calls
`ScriptMgr::OnAreaTrigger()`, and stops default quest/tavern/PvP/teleport
handling when the hook returns true. Boolean meanings differ by hook; inspect
the call site.

Map script constructors also carry map ID. Generic dispatch stops at the first
matching script of a map type. Since registry iteration order is unordered,
duplicate map/type registrations are unsafe.

## AI selection

`FactorySelector::SelectAI()` forces `PetAI`, then asks a DB-bound
`CreatureScript`, then uses template `AIName`, then highest permitted core AI.
Gameobjects similarly try C++ script first. Do not combine a C++ AI-returning
`ScriptName` and `AIName='SmartAI'` expecting both.

C++ behavior should keep delayed identities as GUIDs, clear events/tasks/
summons on lifecycle reset, revalidate after reentrant calls, respect map
ownership, and use engine APIs for movement/combat/vehicles/persistence.

## Build and loader wiring

Top-level modules live under `src/server/scripts/`. CMake supports `SCRIPTS`
`none`, `static`, `dynamic`, `minimal-static`, or `minimal-dynamic`; per-module
`SCRIPTS_<MODULE>` accepts `default`, `disabled`, `static`, `dynamic`.

CMake generates module entry points from `ScriptLoader.cpp.in.cmake`:
`AddScripts()`, revision hash, module name, and build directive. Module loaders
remain explicit; for example `Commands/cs_script_loader.cpp` calls every
command `AddSC_*`.

A new script needs class plus `AddSC_*`, module-loader registration, exact DB
binding where applicable, CMake reconfiguration, startup-log checks, and
behavior testing. The Custom loader is locally modified in this snapshot; see
`12-local-playground.md`.

## SmartAI

SmartAI uses `AIName='SmartAI'` for creatures,
`AIName='SmartGameObjectAI'` for gameobjects, `smart_scripts`, and optional
conditions/text/waypoint/action-list data.

`SmartAIMgr::LoadSmartAIFromDB()` validates source existence/type, configured
AI, enums, parameters, references, links, and conditions.

| Source type | This branch |
|---|---|
| Creature, gameobject, area trigger, timed action list | Supported |
| Event, gossip, quest, spell, transport, instance | NYI |
| Scene/entity variants | Other-branch reservations |

Positive `entryorguid` addresses a template; negative addresses a supported
spawn. Runtime first checks spawn-specific rows then template rows.

Each live `SmartScript` copies its event list at initialization. Reload replaces
manager source data but does not rewrite every active AI. Validate respawned or
newly initialized objects after reload.

`OnUpdate()` installs/sorts pending events, updates events and timed lists, then
executes actions. Conditions are checked at dispatch. Nested processing is
limited to 10 levels. Debug-only rows require `TRINITY_DEBUG`.

For SmartAI area triggers, bind `SmartTrigger` in `areatrigger_scripts`, add
area-trigger source rows by DBC ID, and add conditions. Living players process
the event and consume default handling; dead players return false.

Snapshot note: one empty-result log says `smartai_scripts`; query/schema use
`smart_scripts`.

## Legacy DB scripts

The generic DB interpreter supports `event_scripts` and `waypoint_scripts`.
`ObjectMgr::LoadScripts()` validates rows and stores delay-ordered
`ScriptInfo`s. `Map::ScriptsStart()` schedules source/target/item GUIDs and a
pointer to loaded `ScriptInfo`; zero-delay commands can run immediately.

The schedule retains pointers into loaded maps. Reload is refused while
`MapManager::IsScriptScheduled()`; a long delayed row anywhere can block global
reload. Do not bypass the guard or mutate loaded rows in place.

## Command construction

Code-only `CommandScript`s contribute `ChatCommandTable`s.
`ChatCommandNode::LoadCommandMap()` builds a case-insensitive hierarchy.
Modern entries provide name, typed handler, RBAC permission, and explicit
`Console::Yes`/`No`. Blank subcommands invoke a parent; duplicates assert.

Names containing spaces become nested nodes. Legacy `(ChatHandler*, char
const*)` handlers remain but are deprecated; input is copied because they may
use destructive `strtok`. New commands should be typed.

### Typed parsing

`CommandInvoker` turns a handler signature into a tuple and calls
`ArgInfo<T>::TryConsume()` for each parameter. Unless the final type consumes
the tail, all input must be consumed.

Supported types include numbers, enums, strings/views/wide strings,
`Optional`, arrays, nonempty vectors, `Variant`, tail/quoted/exact sequences,
account/player identifiers, hyperlinks, and validated DBC/object pointers.

`Optional<T>` backtracks: it tries the value, then retries the rest without it.
Avoid adjacent optional/variant grammars that are ambiguous.

Parsing returns remaining input, a localized error, or generic failure.
Specific errors mark the handler; generic failure displays syntax/help unless
the handler already sent an error.

### Lookup and help

At each level, exact case-insensitive match wins, unique prefix is accepted,
ambiguous visible prefixes are listed, and unauthorized/console-incompatible
nodes are hidden.

Help comes from localized `TrinityStrings` or world `command.help`. The world
table cannot override permission or console policy compiled into the builder.
The lazy process-global command map is invalidated when dynamic command scripts
change.

## Execution surfaces

| Surface | Handler | Context | Authorization |
|---|---|---|---|
| In-game chat | `ChatHandler` | World thread | Session RBAC |
| Addon command | `AddonChannelCommandHandler` | World thread | Session RBAC |
| Local console | `CliHandler` | Queued to world thread | Unrestricted except `Console::No` |
| Remote Access | `CliHandler` | Queued to world thread | RA login, console policy |
| SOAP | `CliHandler` | Queued to world thread | SOAP login, console policy |

`CMSG_MESSAGECHAT` is thread-unsafe/world-side. In-game commands require `.` or
`!` and reject lone/repeated prefixes or immediate space. Ordinary players may
not receive command-not-found errors without the matching RBAC permission.

The addon protocol uses exact `TrinityCore\t` prefix, operation, four-byte echo,
and command, replying through addon whispers.

CLI/RA/SOAP allocate `CliCommandHolder`, queue through `World`, and execute via
`World::ProcessCliCommands()`. Completion success is
`!handler.HasSentErrorMessage()`, not only handler return. Handlers must return
true only after intended success, return false on failure, and set the error
flag when they already emitted the meaningful error.

### Remote Access and SOAP

RA is plaintext TCP, authenticates a global (`RealmID=-1`) account at
`Ra.MinLevel` using SRP verifier data, logs full command text, and blocks its
shared-I/O worker during reads and world-command completion. After login it
uses unrestricted CLI permissions, not detailed account RBAC.

SOAP uses plain HTTP Basic credentials, requires administrator security, logs
full command text, queues to world, waits on a promise, and also uses CLI
permissions. Keep both behind trusted encrypted boundaries.

## Command target security

Invocation permission is separate from permission to affect a target. Commands
must explicitly call `HasLowerSecurity()` or `HasLowerSecurityAccount()` where
appropriate. The framework does not inject these checks. CLI bypasses them
because it has no session; use strong checks when equal security must fail.

Also validate target online/offline state, realm/map ownership, self/selection
defaults, persistence completion, and console operation without a player.

## RBAC

| Table | Role |
|---|---|
| `account_access` | Security by account/realm |
| `rbac_permissions` | IDs and names |
| `rbac_linked_permissions` | Recursive links/roles |
| `rbac_default_permissions` | Security-level roots |
| `rbac_account_permissions` | Account grants/denials |

`AccountMgr::LoadRBAC()` loads definitions/links/defaults.
`RBACData::LoadFromDB()` loads account grants/denials for current realm or -1,
adds defaults, recursively expands both, then subtracts denied permissions.

`WorldSession::HasPermission()` loads lazily. `.reload rbac` refreshes globals
and invalidates session caches. `cs_rbac.cpp` uses online session data or a
temporary object for offline accounts and performs explicit security checks.

Permission IDs form a contract among `rbac::RBACPermissions` in `RBAC.h`, auth
base data, migrations, and compiled commands. Never renumber IDs. Add enum,
base row, links/defaults, and forward auth migration together.

## Dynamic hotswap

Runtime replacement exists only with `TRINITY_API_USE_DYNAMIC_LINKING`.
Dynamic script selection forces shared libraries; static builds use an empty
reload manager.

`HotSwapScriptReloadMgr` resolves/watches module/source paths, queues watcher
events, processes them from `World::Update()`, copies changed libraries to
unique cache paths, releases old contexts, loads exports, and swaps registries.
Revision mismatch warns but does not reject; ABI compatibility is operational.

Swap effects differ:

- Creature/gameobject AIs are destroyed/rebuilt, events pruned, charm possibly
  removed, and living creatures reset/evade.
- Commands invalidate the global map.
- Spell loaders rerun validation.
- OutdoorPvP manager restarts.
- Live spell/aura/instance objects keep `ModuleReference`, retaining old code.
- Battlefield/battleground registries do not support context release and
  assert if attempted.

This is a behavioral reset, not seamless state transfer. Old/new code can
coexist until old references die.

Relevant keys include `HotSwap.Enabled`, `ScriptDir`, recompiler/build/install
settings, and prefix correction. Watchers are created at initialization;
config reload does not reconstruct them. Early termination is marked FIXME and
currently delays rather than safely terminating a build. Shutdown clears strong
module refs early to avoid static-destruction crashes.

## Workflows

### C++ creature/gameobject script

1. Choose core, SmartAI, or C++ deliberately and select a unique name.
2. Implement lifecycle cleanup and registration.
3. Add exact template/spawn `ScriptName` in a new world migration.
4. Add `AddSC_*` to loader and reconfigure CMake.
5. Inspect startup `server.loading`, `scripts`, and SQL logs.
6. Test reset, evade, death, respawn, unload, map workers, and hotswap if
   dynamic.

### Command

1. Use typed handler and explicit console policy.
2. Select/add a dedicated permission with enum, base, and migration.
3. Perform target-security checks and define offline/selection/console cases.
4. Keep return/error-flag contract consistent.
5. Add localized or world help and loader registration.
6. Test exact/prefix/ambiguous/malformed/extra input, authorization, every
   surface, and sensitive logging.

### SmartAI

Confirm branch support, template vs spawn key, AI name/SmartTrigger binding,
every referenced row, phase/repeat/chance/link/recursion behavior, then reload
and reinitialize objects before testing lifecycle and long update diffs.

## Hazards and source anchors

- DB-bound names must exist before C++ registration; numeric IDs are unstable.
- Spawn bindings can silently override templates.
- Global hook order is not a contract; first-match map dispatch makes duplicate
  map/type registrations unsafe.
- Hooks inherit caller thread/lifetime.
- C++ AI, SmartAI, and core AI are alternatives.
- SmartAI reload does not rewrite live copies.
- Legacy DB scripts cannot reload with delayed work scheduled.
- Invocation permission and target security are separate.
- CLI, RA, and SOAP have unrestricted command permission; full command text is
  logged and can contain credentials.
- Hotswap resets AI and can retain old libraries; static builds cannot reload.
- New source files require CMake reconfiguration.
- Snapshot review point: lazy command-map construction/invalidation has no
  obvious synchronization with concurrent readline completion.

Primary anchors are `Scripting/ScriptMgr.*`, `ScriptReloadMgr.*`,
`Globals/ObjectMgr.*`, `Maps/MapScripts.cpp`, `AI/CreatureAISelector.cpp`,
`AI/SmartScripts/`, `Chat/Chat.*`, `Chat/ChatCommands/`, `Accounts/RBAC.*`,
`worldserver/CommandLine/`, `RemoteAccess/RASession.cpp`, `TCSoap/TCSoap.cpp`,
script module loaders, and auth/world base SQL.

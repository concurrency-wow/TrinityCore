# TrinityCore 3.3.5 Repository Memory

This memory describes the audited TrinityCore 3.3.5 checkout. It is a
navigation and safety guide, not a replacement for checking current source.

## Audit snapshot

Snapshot facts can become stale after a pull, branch switch, reconfiguration,
or local edit.

| Item | Audited value |
|---|---|
| Branch | `playground-v1` |
| Commit | `a3ada797fdb1577f93b74b1daea688dc5bb89347` |
| Commit date | 2026-07-24 |
| Tracked files | 15,483 |
| Tests | 37 Catch2 `TEST_CASE`s in 10 test source files |
| Current migrations | 3 auth, 1 characters, 97 world |
| Audit method | Broad reference-following, not line-by-line review |

## Authority order

When sources disagree, use this order:

1. Executable C++, CMake, schema, and current migrations.
2. `.conf.dist`, CI workflows, and checked-in operational scripts.
3. Generated templates and required external runtime data.
4. Documentation, which may lag implementation.
5. Dirty, untracked, or ignored local files, which are not upstream authority.

In particular, the locally modified `README.md` and untracked `rebuild.sh`
describe a private workflow, not a checked-in project contract.

## Memory-bank map

| Document | Use it for |
|---|---|
| `memory-bank/01-repository-build.md` | Layout, targets, CMake, generated files, CI, and tools |
| `memory-bank/02-runtime-architecture.md` | Processes, startup, world loop, ownership, threading, and shutdown |
| `memory-bank/03-network-auth-sessions.md` | Auth, sockets, opcodes, packet dispatch, sessions, and world entry |
| `memory-bank/04-database-sql-data.md` | Pools, callbacks, prepared statements, SQL updates, DBC, and extracted data |
| `memory-bank/05-world-gameplay.md` | Maps, entities, persistence, quests, social systems, and PvP |
| `memory-bank/06-spells-combat-ai-movement.md` | Spells, auras, combat, threat, AI, vehicles, and movement |
| `memory-bank/07-scripting-commands.md` | Script registration, DB bindings, SmartAI, commands, RBAC, and hotswap |
| `memory-bank/08-config-logging-observability.md` | Configuration, reloads, logging, metrics, and diagnostics |
| `memory-bank/09-cpp-boost-conventions.md` | Project-specific C++20, ownership, concurrency, and Boost practices |
| `memory-bank/10-testing-validation.md` | Tests, build matrices, sanitizers, SQL checks, and manual verification |
| `memory-bank/11-risks-debt.md` | Security, persistence, performance, coupling, and technical debt |
| `memory-bank/12-local-playground.md` | Snapshot-local files and wagon integration only |
| `memory-bank/evidence-index.md` | High-value source entry points and audit coverage |

## Architecture at a glance

| Area | Primary implementation |
|---|---|
| Build | `CMakeLists.txt`, `cmake/options.cmake`, and target files under `src/` |
| Processes | `src/server/authserver/Main.cpp` and `src/server/worldserver/Main.cpp` |
| Foundations | `src/common/`, `src/server/database/`, and `src/server/shared/` |
| Gameplay | `src/server/game/` |
| Scripts | `src/server/scripts/` plus generated `AddScripts()` wiring |
| Persistence | Auth, characters, and world MySQL databases |
| Client data | `DataDir/dbc`, `DataDir/maps`, `DataDir/vmaps`, and `DataDir/mmaps` |
| Simulation | `WorldUpdateLoop()` -> `World::Update()` -> `MapManager::Update()` |
| Client traffic | `SocketMgr`/`NetworkThread` -> `WorldSocket` -> `WorldSession` |
| Async SQL | DB workers fulfill futures; owner-thread callback processors consume them |

## Core invariants

- Reconfigure after adding source files. `CollectSourceFiles()` uses a
  configure-time recursive glob without `CONFIGURE_DEPENDS`; a plain build
  does not discover a new `.cpp`. See `cmake/macros/AutoCollect.cmake`.
- Thread classification is part of an opcode's correctness. `SessionStatus`
  controls legal player state and `PacketProcessing` selects world- or
  map-side consumption. See `OpcodeTable::Initialize()` in
  `src/server/game/Server/Protocol/Opcodes.cpp`.
- `PROCESS_INPLACE` does not mean socket-thread execution. Normal packets are
  queued by `WorldSocket::ReadDataHandler()`; the first eligible session
  update consumes this classification.
- World-owned mutation generally belongs on the world or owning map thread.
  Cross-thread arrivals use queues such as `World::addSessQueue`,
  `WorldSession::_recvQueue`, and `WorldSocket::_bufferQueue`.
- Prepared statements must match their `CONNECTION_ASYNC`,
  `CONNECTION_SYNCH`, or `CONNECTION_BOTH` flags to the pool API used.
- Do not rewrite a released SQL migration. The updater hashes files and can
  reapply changed contents. Add a new migration.
- The production world base is external. `revision_data.h.in.cmake` names
  `TDB_full_world_335.25101_2025_10_21.sql`.
  `sql/base/dev/world_database.sql` is a development/CI schema, not TDB.
- A successful compile is insufficient to run `worldserver`.
  `World::SetInitialWorldSettings()` requires compatible DBC and extracted
  map/vmap data.
- Configuration defaults are executable policy. Start from
  `src/server/{authserver,worldserver}/*.conf.dist`; extra `.conf` files and
  `TC_*` environment variables can override values through `ConfigMgr`.
- Singleton and destruction order matter. Many managers are function-static
  singletons, while each `Main.cpp` uses scoped handles to impose cleanup
  before process-static destruction.

## Task routing

| Change | Start here | Typical validation |
|---|---|---|
| New source file | `01-repository-build.md` | Rerun CMake, build PCH and no-PCH where practical |
| Opcode/packet | `03-network-auth-sessions.md` | Malformed input, state, threading, and flood tests |
| Prepared statement/schema | `04-database-sql-data.md` | Fresh DB, upgraded DB, prepare phase, second updater run |
| Creature or vehicle script | `07-scripting-commands.md` | Loader, exact SQL `ScriptName`, startup, in-game behavior |
| Spell or aura behavior | `06-spells-combat-ai-movement.md` | Registration, validation, cast and lifecycle paths |
| Command | `07-scripting-commands.md` | Parser, RBAC, console policy, and target permissions |
| Config setting | `08-config-logging-observability.md` | Missing/default/invalid/reload/environment cases |
| Threading or lifetime change | `02-runtime-architecture.md`, `09-cpp-boost-conventions.md` | Saturation, cancellation, owner-thread, and shutdown tests |

## Rules for future work

1. Confirm the current branch and diff before trusting snapshot-specific facts.
2. Follow symbols from declaration through registration and call sites; folder
   names alone do not establish ownership or execution context.
3. Keep local playground behavior in `12-local-playground.md`, not in durable
   descriptions of upstream architecture.
4. Prefer project abstractions and nearby canonical examples over introducing
   a second concurrency, ownership, formatting, or registration pattern.
5. Record thread context, lifetime owner, persistence semantics, and all
   registration/data coupling for every non-trivial change.
6. Update the relevant topic file when architecture or workflow changes.
7. Update the snapshot table only after rechecking counts and checkout state.
8. Keep references symbol- or path-based rather than line-based so they remain
   useful across small upstream changes.

## Current local work

The audit found pre-existing local changes. Do not overwrite, clean, stage, or
treat them as upstream without explicit instruction:

- Modified: `README.md`
- Modified: `src/server/scripts/Custom/custom_script_loader.cpp`
- Untracked: `compile_commands.json`
- Untracked: `doc/LAN-Connection-Guide.md`
- Untracked: `generated-ai-tools/`
- Untracked: `rebuild.sh`
- Untracked:
  `src/server/scripts/Custom/vehicle_scripts/redridge_transportation_script_v1.cpp`
- Ignored: `sql/custom/world/2026_07_27_00_world_public_wagon.sql`

See `memory-bank/12-local-playground.md` for the snapshot-local coupling and
known deployment assumptions.

## Audit review points

These are candidates for focused testing, not declarations of confirmed
production vulnerabilities:

- DB worker cancellation clears queued operations; no explicit final async DB
  drain was found before pool closure.
- Signal-driven `World::StopNow()` can stop between ticks and bypass work that
  only runs from an `IsStopped()` branch inside `World::Update()`.
- Remote Access uses blocking plaintext reads in a shared I/O executor and has
  no obvious command-line length bound.
- The auth TOTP suffix deserves explicit bounds tests.
- World authentication parses `Build` and `DosResponse` without validating
  them in the acceptance decision.
- SOAP is plain HTTP and should stay behind a trusted boundary.
- The SQL updater suppresses credential logging but passes `-p<password>` to
  the external MySQL process.
- Synchronous DB connection acquisition busy-spins until one is available.

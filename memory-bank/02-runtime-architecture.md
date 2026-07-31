# Runtime Architecture

## Process model

TrinityCore runs two principal processes:

| Process | Responsibility | Entry point |
|---|---|---|
| `authserver` | SRP authentication, realm discovery, ban expiry, realm refresh | `src/server/authserver/Main.cpp::main` |
| `worldserver` | World authentication, sessions, simulation, gameplay, scripts, persistence | `src/server/worldserver/Main.cpp::main` |

They share the auth database but have different runtime models. `authserver`
is mostly event-driven; `worldserver` has a dedicated simulation loop plus
I/O, map, and database workers.

## Configuration precedence

Both entry points use `ConfigMgr` from
`src/common/Configuration/Config.cpp`:

1. Load the main file supplied by `--config`.
2. Recursively load `.conf` files from `--config-dir`; later keys replace
   earlier values.
3. Apply environment overrides.
4. On reload, reload retained files and reapply environment overrides.

Environment names begin with `TC_` and convert configuration names to
uppercase snake case. `WorldServerPort` becomes `TC_WORLD_SERVER_PORT` and
`LogDB.Opt.ClearTime` becomes `TC_LOG_DB_OPT_CLEAR_TIME`. See
`IniKeyToEnvVarKey()`.

On Unix, compiled defaults point to `${CONF_DIR}/authserver.conf` and
`${CONF_DIR}/worldserver.conf`; see the server `CMakeLists.txt` files.

## Worldserver startup

`src/server/worldserver/Main.cpp::main` establishes deliberate lifetime order:

1. Set process identity, signal/abort handling, OS checks, and locale.
2. Parse command-line options and load configuration.
3. Construct the shared Asio `IoContext`; initialize logging, OpenSSL, PID
   handling, and process priority.
4. Register signals before running the I/O executor.
5. Create `Trinity::ThreadPool` and post `ioContext->run()` once per worker.
6. Call `StartDB()` for login, character, and world pools.
7. Mark the realm offline and load its `realmlist` row.
8. Initialize metrics and install generated `AddScripts` in `ScriptMgr`.
9. Initialize secrets and call `World::SetInitialWorldSettings()`.
10. Start optional Remote Access and SOAP services.
11. Start `WorldSocketMgr`, then clear the realm's offline flag.
12. Start freeze detection and the optional console thread.
13. Enter `WorldUpdateLoop()` on the main thread.

The distribution sets `ThreadPool = 2`, while the code fallback is one. This
pool runs the shared Asio context used by signals, listener accepts, metrics,
asynchronous logging, and Remote Access. It is separate from player network
threads.

`StartDB()` uses `DatabaseLoader`, clears stale online state, writes core
version information, and reads the world DB version before simulation
initialization.

### World initialization phases

`World::SetInitialWorldSettings()` in `src/server/game/World/World.cpp` is an
ordered dependency graph, not a set of independent loads.

| Phase | Representative work |
|---|---|
| Core configuration | `LoadConfigSettings()`, allowed security, highest GUIDs |
| Runtime-data validation | Critical map/vmap checks through `MapManager::ExistMapAndVMap()` |
| Client data | `LoadDBCStores()`, locale detection, cinematic cameras |
| Navigation | Thread-unsafe vmap/mmap manager initialization |
| Static gameplay data | Spells, items, creatures, gameobjects, quests, loot, conditions, waypoints |
| Persistent realm data | Character cache, instances, auctions, guilds, groups, arena teams |
| Script systems | Event/waypoint scripts, spell-script names, `ScriptMgr::Initialize()`, SmartAI |
| Derived caches | Query data, command map, reset times, world timers |
| Active systems | Maps, events, channels, opcodes, battlegrounds, transports, Warden checks |

Comments in this function encode real ordering invariants. Template data must
precede spawns, quests depend on DBC and templates, and scripts initialize
only after data bindings exist. Startup aborts if critical DBC/map data is
absent or incompatible.

## Authserver startup

`src/server/authserver/Main.cpp::main` performs:

1. Configuration, logging, OpenSSL, PID, and process setup.
2. `StartDB()` for the login pool.
3. Secret and IP-location initialization.
4. Construction of one main Asio `IoContext`.
5. `RealmList::Initialize()`, including build information and initial realms.
6. Start of `AuthSocketMgr` on port 3724 by default.
7. Signal, DB keepalive, ban-expiry, and service-status timers.
8. `ioContext->run()` on the main thread.

`AuthSocketMgr` creates one separate `NetworkThread<AuthSession>`. The main
auth I/O context owns the acceptor and periodic timers; accepted sockets run
on the network thread's own context.

`RealmList::UpdateRealms()` periodically reloads `realmlist`, resolves
addresses, and replaces the in-memory map. Its default interval is 20 seconds.

## Concurrency domains

| Domain | Typical work | Evidence |
|---|---|---|
| World main thread | `WorldUpdateLoop()`, global managers, unsafe packets, CLI | `World::Update()` |
| Shared world I/O pool | Listener accepts, signals, timers, metrics, RA callbacks | `worldserver/Main.cpp` |
| Auth main I/O thread | Acceptor, signals, periodic timers, realm refresh scheduling | `authserver/Main.cpp` |
| Player network threads | Socket reads/writes, framing, auth callback polling | `NetworkThread<T>::Run()` |
| Map workers | Map/player/object updates and thread-safe packet handlers | `MapUpdater`, `Map::Update()` |
| Database workers | Queued SQL and promise completion | `DatabaseWorker::WorkerThread()` |
| CLI thread | Blocking console input, then command enqueue | `CliRunnable.cpp` |
| SOAP thread | HTTP accept/serve and world-command wait | `TCSoapThread()` |

Each `NetworkThread<T>` owns a single-concurrency Asio context, an accept
socket, connection vectors, and a 1 ms update timer.
`SocketMgr::SelectThreadWithMinConnections()` directs new connections to the
least-loaded network thread.

The world listener belongs to the shared main `IoContext`.
`AsyncAcceptor` accepts directly into a socket associated with the selected
network thread.

## Cross-thread handoffs

| Producer -> consumer | Mechanism |
|---|---|
| Network auth callback -> world thread | `World::AddSession()` -> `World::addSessQueue` |
| Network reads -> world/map update | `WorldSession::_recvQueue` |
| World/map code -> network writes | Intrusive `MPSCQueue` in `WorldSocket::_bufferQueue` |
| Command frontends -> world thread | `World::cliCmdQueue` |
| DB worker -> owner context | Futures plus `AsyncCallbackProcessor` |
| World thread -> map workers | `MapUpdater::schedule_update()` and `ProducerConsumerQueue` |

The MPSC implementation is in `src/common/Threading/MPSCQueue.h`; blocking
worker queues use `ProducerConsumerQueue.h`. Do not bypass these handoffs by
mutating world/session state directly from a network or DB worker.

## World update loop

`WorldUpdateLoop()` computes elapsed milliseconds, enforces
`MinWorldUpdateTime`, increments `World::m_worldLoopCounter`, and calls
`World::Update(diff)` until `World::IsStopped()`.

`World::Update()` orders major work as follows:

1. Update game time, shutdown countdown, and timers.
2. Refresh who-list and timed/reset state.
3. Save custom channels when due.
4. Process auctions, AH bot, and script file changes.
5. Run `UpdateSessions(diff)` for new sessions and thread-unsafe packets.
6. Update uptime and maintenance jobs.
7. Call `MapManager::Update(diff)`.
8. Update battleground, OutdoorPvP, battlefield, group, and LFG managers.
9. Process world-level SQL callbacks.
10. Process corpses, events, DB keepalive, and instance resets.
11. Execute queued CLI/SOAP/RA commands.
12. Call `ScriptMgr::OnWorldUpdate()` and update metrics.

Metrics wrap the whole tick and named phases through `TC_METRIC_TIMER` calls
in `World::Update()`.

### Map update barrier

`MapManager::Update()` runs when its interval timer passes. For each base map,
it calls `Map::Update()` directly or schedules a `MapUpdateRequest`. It waits
for all scheduled updates before calling every map's `DelayedUpdate()`.

Distributed defaults are `MapUpdateInterval = 10` ms and
`MapUpdate.Threads = 1`. A positive thread count activates `MapUpdater`, so
even one worker moves map updates off the world thread, but the world thread
waits at a barrier. More threads allow different maps to update concurrently;
the slowest map still controls completion.

`Map::Update()` first runs eligible session packets with `MapSessionFilter`,
then updates players, active cells, creatures, objects, respawns, and scripts.

## Ownership and lifetime

The code uses mixed ownership:

- Many managers are function-static `instance()` objects exposed through
  macros such as `sWorld`, `sObjectMgr`, and `sMapMgr`.
- `Main.cpp` creates `shared_ptr<void>` handles with custom deleters to impose
  cleanup order on singleton-backed services.
- Maps, guilds, quests, auras, vehicles, and other objects often use
  `Trinity::unique_trackable_ptr`, providing unique ownership with weak
  references.
- Sockets use `shared_ptr` because asynchronous handlers retain themselves.
- `World` owns raw `WorldSession*` entries in `m_sessions` and deletes them
  during update or destruction.
- `WorldSocket` keeps a guarded raw `WorldSession*`; `WorldSession` holds a
  shared socket reference. `World::AddSession_()` notes a remaining race.

For lifetime-sensitive code, identify both logical owner and the thread on
which destruction is permitted.

## Shutdown

### World process

A signal callback calls `World::StopNow()`, setting an atomic stop flag and
exit code. The loop exits, after which `main()`:

1. Stops the shared `IoContext`.
2. Destroys the I/O thread pool.
3. Makes logging synchronous.
4. Calls `ScriptMgr::OnShutdown()`.
5. Marks the realm offline.
6. Returns, triggering reverse-order scoped cleanup.

Scoped cleanup then joins CLI, kicks and updates sessions, stops player
networking, clears online flags, joins SOAP, unloads maps/scripts/metrics, and
closes databases.

A command-driven shutdown uses `World::ShutdownServ()` and
`_UpdateGameTime()`, allowing countdown messages and script hooks before
setting the stop state.

### Auth process

The signal handler stops the main `IoContext`. After `run()` returns, timers
are canceled; reverse destruction stops networking, closes `RealmList`, and
closes the login database.

## Shutdown review points

- `DatabaseWorker::~DatabaseWorker()` calls
  `ProducerConsumerQueue::Cancel()`, which deletes queued operations. No
  explicit final queue-drain phase was found before pool closure.
- A signal can set `World::m_stopEvent` between ticks. The loop exits without
  another `World::Update()`, so an `IsStopped()` branch used for custom-channel
  saving may not run.
- `RASession::Start()` switches to blocking mode and performs blocking
  `read_until()` calls in the shared I/O worker. An idle client can occupy an
  executor thread and impede shutdown.
- `MapUpdater` waits for pending requests before canceling workers, so shutdown
  waits for the slowest active map.
- `DatabaseWorkerPool::GetFreeConnection()` busy-spins until a synchronous
  connection lock succeeds and can stall a world/map execution context.

These points deserve shutdown and saturation tests before structural changes.

## Runtime tracing

Useful anchors include:

- Startup/loading: `server.worldserver`, `server.authserver`,
  `server.loading`.
- SQL: `sql.driver`, `sql.sql`, `sql.updates`, `sql.performances`.
- Player traffic: `network`, `network.opcode`, optional packet logs.
- Admin surfaces: `commands.ra`, `network.soap`.
- Metrics: `world_update_time`, `map_update_time_diff`,
  `worldsession_update_opcode_time`.
- Freeze detection: `FreezeDetector::Handler()` watches
  `World::m_worldLoopCounter` and aborts after `MaxCoreStuckTime`.

When diagnosing a stall, determine whether it is the world loop, a map
barrier, synchronous SQL acquisition, a blocked shared-I/O worker, or network
thread processing.

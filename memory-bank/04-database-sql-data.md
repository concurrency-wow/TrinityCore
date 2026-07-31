# Database, SQL, and Runtime Data

## Scope and database roles

Primary implementation lives under `src/server/database/Database/`,
`src/server/database/Updater/`, `src/server/game/DataStores/`,
`src/server/shared/DataStores/`, and `sql/`.

| Database | Primary contents | Consumers |
|---|---|---|
| Auth/login | Accounts, SRP/session keys, bans, RBAC, realms, builds, uptime | Both servers |
| Characters | Characters, inventory, spells, quests, social state, auctions, instances | `worldserver` |
| World | Templates, spawns, scripts, loot, conditions, waypoints, DBC overlays | `worldserver` |

Typed pools are exposed by `DatabaseEnv.h` and implemented by
`LoginDatabaseConnection`, `CharacterDatabaseConnection`, and
`WorldDatabaseConnection` under `Database/Implementation/`.

Transactions belong to one pool. There is no cross-database atomic transaction
across auth, characters, and world.

## Connection configuration

`MySQLConnectionInfo` in `Database/MySQLConnection.cpp` parses:

```text
host;port-or-socket;user;password;database[;ssl]
```

Normal keys are `LoginDatabaseInfo`, `CharacterDatabaseInfo`, and
`WorldDatabaseInfo`; counts use `<Name>Database.WorkerThreads` and
`<Name>Database.SynchThreads`.

`DatabaseLoader::AddDatabase()` permits 1-32 asynchronous workers. Authserver
notes that more than one synchronous connection is not useful while its
controlling flow remains single-threaded.

Connections use `utf8mb4`. An optional `ssl` sixth token requires/enforces SSL
through the MySQL client. Startup supports MySQL 8.0.34+ or MariaDB 10.6.3+.

## Startup lifecycle

Worldserver `StartDB()` in `src/server/worldserver/Main.cpp` initializes the
MySQL library and login, character, and world pools, reads `RealmID`, clears
stale online state, writes core revision data, and loads the world DB version.

Authserver initializes only `LoginDatabase`. Distributed update defaults are:

| Process config | `Updates.EnableDatabases` |
|---|---:|
| `worldserver.conf.dist` | 7, all three mask bits |
| `authserver.conf.dist` | 0, disabled |

Both executables accept `--update-databases-only` or `-u`.

`DatabaseLoader::Load()` runs four ordered stages from
`Database/DatabaseLoader.cpp`:

1. Open configured async and sync connections. It may create a missing DB when
   updates and `Updates.AutoSetup` allow it.
2. Populate an empty DB from its configured base.
3. Apply updates from `updates_include`.
4. Prepare native statements against the final migrated schema.

On failure, registered pools close in reverse order.

## Worker-pool model

`DatabaseWorkerPool<T>` has asynchronous and synchronous connection groups.

### Asynchronous workers

Each async connection has `DatabaseWorker`; all workers in one pool consume a
shared `ProducerConsumerQueue<SQLOperation*>`. A worker attaches its connection
to a dequeued operation, executes it, fulfills any promise, then deletes the
operation.

Increasing workers permits unrelated operations to run concurrently. Ordering
between separately enqueued operations is not a persistence contract. Put
ordered, atomic writes in one transaction.

### Synchronous connections

`DatabaseWorkerPool<T>::GetFreeConnection()` repeatedly tries each connection's
`LockIfReady()` until one succeeds. It does not sleep or time out, so a sync
query can busy-spin and extend a world/map tick while connections are occupied.

Debug builds can report synchronous-query stacks. `WorldUpdateLoop()` and
`MapUpdater::WorkerThread()` enable `WarnAboutSyncQueries(true)` in their
contexts.

### Pool closure

`DatabaseWorkerPool<T>::Close()` clears async connections before sync ones.
`DatabaseWorker::~DatabaseWorker()` sets cancellation and calls the shared
queue's `Cancel()`, which deletes queued operations. Destroying the first
worker begins cancellation for the whole pool.

No explicit final asynchronous queue-drain phase was found in worldserver
shutdown. Shutdown-sensitive writes need a completion strategy; enqueueing a
fire-and-forget operation alone is not a durability guarantee.

## API selection

The public API is in `Database/DatabaseWorkerPool.h`.

| Need | API | SQL context | Completion context |
|---|---|---|---|
| Fire-and-forget prepared write | `Execute(stmt)` | DB worker | None |
| One-off raw write | `Execute(sql)` / `PExecute()` | DB worker | None |
| Blocking write | `DirectExecute()` | Caller | Caller |
| Blocking result | `Query()` / `PQuery()` | Caller | Caller |
| Async result | `AsyncQuery()` | DB worker | Owner callback processor |
| Batched reads | `DelayQueryHolder()` | One DB worker/connection | Owner processor |
| Ordered write bundle | `CommitTransaction()` | DB worker | None |
| Result-bearing transaction | `AsyncCommitTransaction()` | DB worker | Owner processor |
| Blocking transaction | `DirectCommitTransaction()` | Caller | Caller |

Raw string APIs are intended mainly for one-time startup operations. Repeated
or client-derived operations should use prepared statements.

Submission APIs own the prepared-statement proxy. It is deleted after direct
execution or by the queued task/transaction/holder. Do not reuse it.

## Callback execution contexts

`AsyncQuery()` enqueues SQL and returns `QueryCallback` around a future. The DB
worker fulfills the future; it never runs gameplay callbacks.
`AsyncCallbackProcessor<T>` invokes ready callbacks only when its owner polls.

| Owner | Polling symbol | Callback thread |
|---|---|---|
| `AuthSession` | `AuthSession::Update()` | Auth network thread |
| `WorldSocket` | `WorldSocket::Update()` | World network thread |
| `WorldSession` | `WorldSession::ProcessQueryCallbacks()` | Current world/map session context |
| `World` | `World::ProcessQueryCallbacks()` | World thread |

The callback owner, not the pool, determines execution context. In particular,
a socket callback is not world-thread safe, and a session callback may run
world- or map-side depending on player state. Capture weak references or stable
IDs when lifetime is uncertain and re-resolve state in the callback.

`QueryCallback` in `Database/QueryCallback.h` supports raw/prepared callbacks,
follow-up query chaining, and `SetNextQuery()`. A null result means no rows and
must be handled explicitly.

## Query holders

`SQLQueryHolder<T>` stores prepared statements/results at explicit indexes.
`SQLQueryHolderTask::Execute()` runs the sequence on one worker connection and
fills each result before one completion callback.

This is useful for character login. It provides one queued operation, one
connection, stable result slots, and one continuation. It is not parallel and
does not add transaction isolation.

Holder invariants:

- Call `SetSize()` before assigning indexes.
- Keep every index in range.
- Use statements prepared for async connections.
- Tolerate individual null results.
- Keep the shared holder alive through future and callback.

## Prepared statements

Each DB defines a typed statement enum and connection under
`Database/Implementation/`. `DoPrepareStatements()` resizes to the terminal
`MAX_*DATABASE_STATEMENTS` and registers:

```cpp
PrepareStatement(index, sql, connectionFlags);
```

The naming convention documented in `CharacterDatabase.h` is:

```text
{DB}_{SEL|INS|UPD|DEL|REP}_{SUMMARY}
```

### Connection modes

| Flag | Prepared on | Compatible API family |
|---|---|---|
| `CONNECTION_ASYNC` | Worker connections | `Execute`, `AsyncQuery`, transaction, holder |
| `CONNECTION_SYNCH` | Synchronous connections | `Query`, `DirectExecute` |
| `CONNECTION_BOTH` | Both | Either |

A mismatch can leave the selected connection without the indexed native
statement. Native `Execute`/`Query` assert that it exists.

During preparation, the pool records placeholder counts.
`GetPreparedStatement()` creates a typed proxy with that capacity. Bind methods
assert index range. Bind every placeholder with correct width/signedness; use
`setString()`/`setStringView()` for text, `setBinary()` for binary values, and
`setNull()` only where schema and SQL permit it.

### Adding a prepared statement

1. Choose the owning database.
2. Add the enum value before `MAX_*DATABASE_STATEMENTS`.
3. Add `PrepareStatement()` in that DB's `DoPrepareStatements()`.
4. Select flags from the actual calling API.
5. Obtain it from the matching typed pool.
6. Bind every placeholder and submit exactly once.
7. Add any needed migration and base-schema update.
8. Test no-row results, errors, reconnects, and callback lifetime.

Never concatenate untrusted values to avoid adding a statement.

## Transactions

`BeginTransaction()` returns `Transaction<T>`. `TransactionBase` owns appended
raw strings and prepared proxies. Statements run in order on one connection,
wrapped by `MySQLConnection::ExecuteTransaction()`.

- `CommitTransaction()` is fire-and-forget.
- `AsyncCommitTransaction()` returns `TransactionCallback` with success.
- `DirectCommitTransaction()` blocks.

If gameplay behavior depends on durable success, use the result-bearing API.
Do not enqueue a transaction and immediately report confirmed persistence.

`TransactionTask::Execute()` detects `ER_LOCK_DEADLOCK`; retries serialize via
`_deadlockLock` for up to `DEADLOCK_MAX_RETRY_TIME_MS` (60 seconds). This can
occupy a worker and delay queued operations, so transaction contents must be
retry-safe. Only a result-bearing submission reports final failure.

Transactions do not coordinate separate databases. Multi-DB workflows need
explicit sequencing, idempotency, retry, and compensation.

## Representative traces

### Auth challenge

```text
AuthSession::HandleLogonChallenge()
  -> LOGIN_SEL_LOGONCHALLENGE
  -> LoginDatabase.AsyncQuery()
  -> DatabaseWorker::WorkerThread()
  -> future ready
  -> AuthSession::Update() on auth network thread
  -> AuthSession::LogonChallengeCallback()
```

See `src/server/authserver/Server/AuthSession.cpp`.

### World authentication

```text
WorldSocket::HandleAuthSession()
  -> LoginDatabase.AsyncQuery(LOGIN_SEL_ACCOUNT_INFO_BY_NAME)
  -> WorldSocket callback on network thread
  -> WorldSession::LoadPermissionsAsync()
  -> WorldSocket::LoadSessionPermissionsCallback()
  -> World::AddSession()
  -> World::addSessQueue
  -> World::AddSession_() on world thread
  -> WorldSession::InitializeSession()
  -> CharacterDatabase.DelayQueryHolder()
  -> session callback processor
```

RBAC loads before the world handoff because queue decisions need permissions.

### Character login

`WorldSession::HandlePlayerLoginOpcode()` in `CharacterHandler.cpp` validates
ownership, initializes `LoginQueryHolder`, waits through the session processor,
calls `Player::LoadFromDB()`, enters the map, and queues online-state writes.

The holder combines character, inventory, aura, spell, quest, guild,
reputation, cooldown, and related reads. While no player is in world, its
completion is consumed world-side.

### Startup loads

`World::SetInitialWorldSettings()` intentionally performs synchronous startup
reads after migrations and preparation but before opening the listener. Loader
order is a correctness dependency.

## Base schemas and data

| Database | Population source |
|---|---|
| Auth | `sql/base/auth_database.sql` |
| Characters | `sql/base/characters_database.sql` |
| Production world | External TDB full-world release |
| Development/CI world | `sql/base/dev/world_database.sql` |

`revision_data.h.in.cmake` currently defines the external world base as:

```text
TDB_full_world_335.25101_2025_10_21.sql
```

If an empty world DB is found without this file, `DBUpdater::Populate()` asks
the operator to download it from TrinityCore releases and place it in the
process working directory.

The development world schema is a CI fixture without production content. Do
not use it as a normal TDB import. `CONTRIBUTING.md` requires auth and character
base files to change alongside their schema migrations.

## SQL layout

| Path | Purpose |
|---|---|
| `sql/create/` | Database/user creation helpers |
| `sql/base/` | Auth/characters bases and development world schema |
| `sql/updates/<database>/3.3.5/` | Current tracked migrations |
| `sql/custom/<database>/` | Deployment-local migrations |
| `sql/old/3.3.5a/` | Archived history |

Snapshot migration counts are 3 auth, 1 characters, and 97 world. They are not
stable invariants.

## Update metadata and discovery

The `updates` table records basename, SHA-1, `RELEASED`/`ARCHIVED` state,
timestamp, and execution milliseconds. `updates_include` stores scanned paths
and states. Paths beginning with `$` resolve relative to `SourceDirectory`.

Standard included categories are current, archived, and local custom SQL.
Verify live world `updates_include` rows because initial world metadata comes
from external TDB.

`DBUpdater<T>::Update()` uses `UpdateFetcher` to:

1. Read included paths and resolve `$` against `SourceDirectory`.
2. Recursively scan to depth 10 for `.sql` files.
3. Order files by basename.
4. Compare available files with name/hash/state/timestamp history.
5. Apply unseen files, detect same-hash renames, optionally fill hashes,
   reapply changed hashes, and update state-only changes.

`UpdateFetcher::PathCompare` compares only `path.filename()`. Duplicate
basenames across any included directories are fatal.

Editing an applied migration changes its hash and can cause it to execute
again. Always add a new migration.

History entries without files are dirty references. Cleanup only occurs when
the missing count is within `Updates.CleanDeadRefMaxCount` (default 3), limiting
damage from a wrong checkout or `SourceDirectory`.

## Applying migration files

`DBUpdater::ApplyFile()` invokes the external MySQL executable with:

```text
BEGIN; SOURCE <path>; COMMIT;
```

It uses `utf8mb4`, raises maximum packet size, and adds SSL arguments when
configured. DDL can implicitly commit, so this wrapper does not make every
migration rollback-atomic.

Relevant defaults:

| Option | Default | Meaning |
|---|---:|---|
| `Updates.AutoSetup` | 1 | Create/populate missing or empty DBs when possible |
| `Updates.Redundancy` | 1 | Hash and detect changed updates |
| `Updates.ArchivedRedundancy` | 0 | Skip expensive archived checks |
| `Updates.AllowRehash` | 1 | Fill empty stored hashes |
| `Updates.CleanDeadRefMaxCount` | 3 | Bound orphan-history cleanup |

`DBUpdaterUtil::CheckExecutable()` checks the configured path then searches
`PATH` for `mysql`.

## Migration rules

### Ownership

- Accounts, credentials, bans, RBAC, realms, and builds belong in auth.
- Players, guilds, groups, auctions, and instances belong in characters.
- Templates, spawns, scripts, conditions, loot, text, and waypoints belong in
  world.

### Naming and history

`CONTRIBUTING.md` specifies `YYYY_MM_DD_i_database.sql`. It recommends an
impossible temporary date for PRs where merge-time collisions are likely.
Basenames must remain unique across current, custom, and archived includes.

Once a migration may be deployed, do not edit it, rename and modify it, or
delete history to force it. Create a new migration. Clean rename detection
requires unchanged content and absence of the old path.

### Base alignment

For auth/characters schema changes, add a migration and update the matching
base. Verify defaults, indexes, charset/collation, prepared statements, both a
migrated old DB and a fresh base. World changes normally remain migrations
until incorporated into a later external TDB.

Make prerequisite template/spawn/script/DBC assumptions explicit. Avoid
deriving nullable IDs and using them in later inserts without validation.

## DBC and SQL overlays

`World::SetInitialWorldSettings()` calls `LoadDBCStores(m_dataPath)` before
most world loaders. `DBCStorage<T>` in
`src/server/shared/DataStores/DBCStore.h` validates record size, loads binary
records and localized strings, exposes ID lookup/iteration, and can overlay
selected records from world SQL.

Current extended stores are:

| DBC | World table |
|---|---|
| `Achievement.dbc` | `achievement_dbc` |
| `Spell.dbc` | `spell_dbc` |
| `SpellDifficulty.dbc` | `spelldifficulty_dbc` |

The 3.3.5 branch has no modern hotfix subsystem. These targeted overlays and
ordinary world tables are its server-side overrides. `DBCStores.cpp` also
builds derived faction, talent, taxi, map-difficulty, appearance, and other
indexes. Structure changes may require format and derived-index updates.

## World-loader ordering

`World::SetInitialWorldSettings()` is the authority for loader order:

- DBC before spell, item, quest, map, and vehicle validation.
- Page text before gameobject templates.
- Creature/gameobject templates before spawns and addons.
- Templates and DBC before quests.
- Quests before starters/enders, pools, conditions, and related SmartAI.
- Script-name mappings before `ScriptMgr::Initialize()`.
- Script initialization before spell-script validation.
- Character cache before guild, arena-team, and group restoration.
- World states before PvP and condition systems.

Insert a new loader next to its dependencies, not at an arbitrary end. A
startup loader is not automatically safe to expose as a live reload command.

## Extracted runtime data

`World::LoadConfigSettings()` reads immutable-at-reload `DataDir` and stores it
with a trailing slash.

| Directory | Purpose | Producer |
|---|---|---|
| `dbc/` | Client records/locales | `mapextractor` |
| `maps/` | Terrain and liquids | `mapextractor` |
| `vmaps/` | Collision, LOS, height, indoor data | `vmap4extractor`, `vmap4assembler` |
| `mmaps/` | Detour navigation meshes | `mmaps_generator` |

`MapManager::ExistMapAndVMap()` checks representative race start locations and
terminates startup if critical files are absent. Builds and schemas alone do
not make a runnable server.

## Safe workflows

### Database-backed feature

1. Identify owning DB and data lifetime.
2. Design migration before call-site SQL.
3. Add prepared statements with correct connection flags.
4. Choose blocking, fire-and-forget, or completion-sensitive semantics.
5. Choose a callback owner whose thread may safely mutate state.
6. Avoid synchronous SQL in packet/map updates.
7. Use one transaction for an ordered consistency unit.
8. Use `AsyncCommitTransaction()` when gameplay depends on success.
9. Handle null results and disappearing objects.
10. Validate upgraded and fresh databases.

### Asynchronous read

1. Use an async-capable prepared statement.
2. Call `AsyncQuery()` and attach a prepared callback.
3. Register it with the correct owner processor.
4. Capture stable IDs/weak references for uncertain lifetimes.
5. Revalidate mutable game state after SQL completes.
6. Keep expensive work out of network-thread callback owners.

### Character-login read

Extend the holder result enum and size, add the query in `Initialize()`, read
it from `HandlePlayerLogin()`, preserve ownership checks, and ensure a missing
result cannot strand `m_playerLoading`.

### World content

Add a new migration, validate DBC/template IDs, preserve template/spawn/addon
order, match C++ and SQL `ScriptName`, register scripts, reconfigure for new
sources, run updater-only and full startup, then test both fresh and existing
deployment state.

### World loader

Define ownership, load synchronously only during startup/quiesced reload,
insert after prerequisites, validate foreign IDs, build derived indexes before
exposure, define safe unload/replacement, and log count and elapsed time.

## Validation

For auth and characters, import each checked-in base into an empty database,
run current migrations, ensure statement preparation succeeds, then rerun the
updater and confirm no work remains.

For world, test both the external TDB release and CI-style development schema.
Do not infer production content completeness from the latter.
`.circleci/config.yml` and `contrib/check_updates.sh` provide canonical CI
examples.

For upgrades, preserve real update history, run
`worldserver --update-databases-only`, inspect `sql.updates`/`sql.sql`, verify
schema and data, restart, and ensure no unintended reapplication.

Runtime checks should cover loader completion, prepared statements, DB version,
affected world loaders, callback context, queue metrics, and shutdown durability.
Useful metrics include `db_queue_login`, `db_queue_character`, and
`db_queue_world`.

Failure tests should include null results, duplicate basenames, changed
recorded migrations, wrong `SourceDirectory`, missing MySQL executable/world
base, deadlocks, callback owner destruction, shutdown backlog, missing runtime
data, and absent prerequisite rows.

## Hazards

- Queue cancellation can discard writes at shutdown.
- Synchronous acquisition busy-spins and can stall latency-sensitive threads.
- `Execute()`/`CommitTransaction()` confirm enqueueing, not durability.
- Callback thread follows the owner processor and may be surprising.
- No transaction spans databases.
- Migration files are executable history; changed hashes can reapply.
- A wrong source directory can make history look orphaned.
- Gitignored custom SQL can still execute via `updates_include`.
- DDL may implicitly commit despite the updater wrapper.
- Updater credentials are suppressed from logs but passed as process args.
- Raw SQL risks injection and sensitive error logging; prefer statements.
- DBC/maps/vmaps/mmaps must match this branch/client build.

See `12-local-playground.md` for the ignored local wagon migration and its
snapshot-specific assumptions.

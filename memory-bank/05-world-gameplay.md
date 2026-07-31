# World and Gameplay

## Scope and execution boundary

Primary code is under `src/server/game/Maps/`, `Entities/`, `Instances/`,
`Groups/`, `Guilds/`, `DungeonFinding/`, `Battlegrounds/`, `OutdoorPvP/`,
`Mails/`, `Loot/`, and `AuctionHouse/`.

| State | Typical owner | Normal mutation context |
|---|---|---|
| Static definitions | `ObjectMgr`, DBC stores, template managers | Startup or controlled reload |
| Live world objects | A specific `Map` and its grids | Owning map update |
| Realm-wide services | Group, guild, auction, LFG, battleground managers | World thread |
| Character state | In-memory owner plus characters DB | Owner context submits DB work |

Different maps and instances can update concurrently through `MapUpdater`.
Finding an object through `ObjectAccessor` does not grant permission to mutate
it. Mutation normally belongs to its current map update.

`MapManager::Update()` waits for all map work before `Map::DelayedUpdate()` and
before `World::Update()` advances to realm-wide managers. This barrier is the
normal boundary for coordinating multiple maps.

Packet classification reinforces this boundary. Map-local handlers may use
`PROCESS_THREADSAFE`; realm-wide mutation normally uses
`PROCESS_THREADUNSAFE`. Auction and mutating LFG handlers are world-side in
`src/server/game/Server/Protocol/Opcodes.cpp`.

## Map hierarchy and ownership

| Type | Responsibility |
|---|---|
| `MapManager` | Owns base maps and coordinates update barrier |
| `Map` | Owns one live simulation and map-local indexes |
| `MapInstanced` | Base placeholder owning dungeon/raid or battleground copies |
| `InstanceMap` | Dungeon/raid copy with binds, unload/reset, and `InstanceScript` |
| `BattlegroundMap` | Battleground copy associated with a `Battleground` |

`MapManager::MapMapType` and `MapInstanced::InstancedMaps` use
`Trinity::unique_trackable_ptr<Map>`. An `InstanceSave` is separate from an
`InstanceMap`: the save can remain while the map is absent, and a map can be
recreated from the save.

A `Map` tracks players, grids/cells, map-local object stores and spawn indexes,
active non-player objects, transports, respawns/spawn groups, update and
removal queues, applicable GUID generators, collision, weather, zone state,
and scheduled map scripts.

`ObjectMgr` owns templates and spawn definitions, not live creature/gameobject
instances. See `src/server/game/Globals/ObjectMgr.*` and
`src/server/game/Grids/ObjectGridLoader.cpp`.

## Map update phases

```text
World::Update()
  -> MapManager::Update()
       -> schedule Map::Update() / InstanceMap::Update()
          -> map-safe session packets
          -> respawns
          -> players and nearby cells
          -> active non-player objects
          -> transports
          -> object field updates
          -> map scripts and local systems
       -> wait for every map request
       -> Map::DelayedUpdate()
          -> far-spell callbacks
          -> transport delayed work
          -> deferred switches/removals
          -> grid transitions and unloading
```

`Map::Update()` marks visited cells so an object is not updated repeatedly
because several players/active objects share its activation area. It also
visits distant dependencies such as combat opponents, aura casters,
viewpoints, and summons.

`InstanceMap::Update()` calls `Map::Update()` then its `InstanceScript`.
`MapInstanced::Update()` can schedule loaded copies separately, so instances
can execute concurrently.

`Map::DelayedUpdate()` runs after the barrier. Cross-map transport completion
belongs there. Do not move delayed deletion or cross-map relocation into the
concurrent phase without redesigning ownership guarantees.

## Grids, activity, and visibility

`src/server/game/Grids/GridDefines.h` separates:

| Container | Representative members |
|---|---|
| World-object container | Players, pets, resurrectable corpses, farsight objects |
| Grid-object container | Ordinary creatures, gameobjects, bones, dynamic objects |

`AllMapStoredObjectTypes` covers creatures, gameobjects, dynamic objects, pets,
and corpses for map lookup. The world/grid split controls unloading and
visitation; it is not global ownership.

Important rules:

- Players and active objects ensure current grids are loaded.
- Non-active objects may exist in a created grid before DB grid data loads.
- Active creatures/gameobjects can switch grid containers.
- `m_activeNonPlayers` keeps nearby cells eligible without players.
- Grid unloading destroys runtime instances; a surviving spawn definition
  does not preserve a live pointer.
- Explicit locks and active flags can prevent unload; unbalanced state leaks
  memory and update work.
- Static transport passengers load only in active grids.

Visibility derives from map position, phase, distance, object state, and each
client's known GUID set. `Map::SendObjectUpdates()` flushes update-field
changes. Creation, relocation, phase, and removal must use map/object APIs so
visibility and queues remain coherent.

## Object lifecycle and lookup

```text
ObjectMgr template/spawn data
  -> ObjectGridLoader creates Creature/GameObject
  -> Create/LoadFromDB sets GUID, map, phase, position
  -> Map::AddToMap()
       -> grid insertion
       -> Object::AddToWorld()
       -> map indexes
       -> active registration
       -> create visibility
```

`Object::AddToWorld()` sets `m_inWorld`, clears stale update masks, and creates
the script weak-reference control block. `Object::RemoveFromWorld()` clears
pending updates and invalidates that reference.

Removal is usually deferred:

```text
WorldObject::AddObjectToRemoveList()
  -> Map::AddObjectToRemoveList()
       -> CleanupsBeforeDelete(false)
       -> queue pointer
  -> Map::DelayedUpdate()
       -> RemoveAllObjectsInRemoveList()
       -> RemoveFromMap(object, true)
```

Cleanup starts when queued, before deletion. An object still in a grid may
already have broken combat, aura, owner, transport, and script links. Do not
retain it for later work. Type-specific `AddToWorld()`/`RemoveFromWorld()` also
maintain GUID/spawn indexes; bypassing them creates stale indexes.

### Lookup rules

`ObjectAccessor` has global `HashMapHolder`s only for `Player` and `Transport`
in this snapshot. Containers use `std::shared_mutex`, but lookup returns a
non-owning pointer after releasing the lock.

- Prefer `ObjectAccessor::GetUnit(source, guid)` or map typed lookup for local
  work.
- `FindPlayer()` excludes connected players not in world;
  `FindConnectedPlayer()` includes transfer/login states.
- Whole-world player access is explicitly not thread-safe.
- `GetPlayers()` requires the caller to hold the player holder lock.
- Lookup does not extend lifetime. Revalidate map, world, phase, and gameplay
  state before mutation.
- Across delayed work and DB/scheduler callbacks, capture GUIDs or supported
  weak references and resolve again.

## Player lifecycle and persistence

### Login

`WorldSession::HandlePlayerLoginOpcode()` in `CharacterHandler.cpp` validates
account ownership, submits `LoginQueryHolder`, creates and loads `Player`,
sends pre-map packets, calls `Map::AddPlayerToMap()`, registers through
`ObjectAccessor`, sends post-map state, marks online state, and announces the
player socially.

`Map::AddPlayerToMap()` validates coordinates, loads the grid, links the
player, calls `AddToWorld()`, initializes self/transport state, builds
visibility, and invokes `ScriptMgr::OnPlayerEnterMap()`.

The query holder is one async operation on one connection, not a transaction
or point-in-time snapshot. When extending login, update size/indexes, tolerate
null results, and clear loading state on every failure path.

### Transfers

A far teleport creates a connected player between maps. Code must handle
`STATUS_TRANSFER`, invalidated map-local pointers, and deferred saving.
`Player::SaveToDB()` schedules `DELAYED_SAVE_PLAYER` while
`IsBeingTeleportedFar()`.

### Logout

Logout is world-side. `WorldSession::LogoutPlayer()` finishes pending far
transfers, releases loot, settles death/battleground state, removes queues,
updates guild state, removes pets, and saves while map-linked. It then cleans
channels, invitations, group/social state, invokes hooks, removes/deletes the
player through the map, clears the session pointer, and queues offline writes.

Changing this order can break pet, inventory, aura, guild, group, or map
persistence.

### Saving

`Player::SaveToDB(bool)` creates one character transaction, delegates to
component saves, then calls `CharacterDatabase.CommitTransaction()`.

Saved components include character state and transport, inventory/items,
quests, spells/talents/glyphs/actions, auras/skills/cooldowns, mail,
battleground state, equipment sets, achievements, reputation, binds, and
statistics.

The transaction is ordered but normally fire-and-forget. Submission is not
durability confirmation. Account online state is in another DB and cannot
share the character transaction.

## Inventory and item lifetime

Inventory separates validation from mutation:

| Validation | Mutation |
|---|---|
| `CanStoreNewItem()` / `CanStoreItem()` | `StoreNewItem()` / `StoreItem()` |
| `CanEquipNewItem()` / `CanEquipItem()` | `EquipNewItem()` / `EquipItem()` |
| `CanBankItem()` | `BankItem()` |

Never mutate using client positions without the matching validator and its
returned destination vector.

`ItemUpdateState` values are `ITEM_UNCHANGED`, `ITEM_CHANGED`, `ITEM_NEW`, and
`ITEM_REMOVED`. `Item::SetState()` coordinates state with the player's item
update queue. A new item changed to removed behaves as if it never existed and
can be deleted immediately.

`Player::_SaveInventory()` validates queued positions, updates inventory rows,
calls `Item::SaveToDB()` in the player transaction, then clears the queue.
`Item::SaveToDB()` deletes `this` for `ITEM_REMOVED`; never dereference it
after saving that state.

Items can move among player inventory/bags, guild banks, mail, auctions, and
loot. A transfer must coherently update memory ownership, placement, item
instance, and destination subsystem. Reuse canonical nearby flows rather than
writing only the visible DB row.

## Quests

Quest templates are startup world data in `ObjectMgr`; per-character log,
progress, reset state, and reward state live on `Player` and in characters DB.

Handlers in `Handlers/QuestHandler.cpp` validate giver identity/range,
start/end relation, status/share state, requirements/prerequisites, log
capacity, objectives, reward choice, and inventory. An earlier gossip or
packet is not authorization for a later reward.

`Player::RewardQuest()` applies items, money, XP/honor/reputation, spells,
status, achievements, and hooks, then performs `SaveToDB(false)`.
`QUEST_STATUS_REWARDED` is explicitly runtime-only in `Quests/QuestDef.h`;
persistence uses surrounding rewarded structures.

A quest change must preserve startup validation, accept/share checks,
objective paths, completion/reward validation, save/load symmetry, and script,
achievement, reputation, and item side effects.

## Loot

Startup `LootStore` caches own templates; generated `Loot` belongs to a
creature, gameobject, corpse, item, or temporary operation. Creature death
generates runtime loot before rewards complete. Group loot adds round-robin,
master-loot, rolls, blocks, and winner state.

`HandleAutostoreLootItemOpcode()` resolves current loot and revalidates source
type, existence, ownership/distance, life, and mode. `Player::StoreLootItem()`
then rechecks slot, already-looted state, `AllowedForPlayer()`, blocking, roll
winner, and `CanStoreNewItem()` before marking looted.

Keep this two-stage validation because source and roll state can change after
opening loot. Container loot may also use `LootItemStorage`; source item
destruction, mail, sale, and buyback must clean associated stored loot.

## Instances, saves, and binds

`InstanceSaveManager` owns active `InstanceSave`s, reset scheduling, and
warning events. Saves track player/group references and may outlive maps.

For ordinary dungeons, `MapInstanced::CreateInstanceForPlayer()` prioritizes:

1. Permanent player bind.
2. Player's saved login instance ID.
3. Group bind.
4. Ordinary player bind.
5. New instance ID.

`InstanceMap::CannotEnter()` rejects capacity, active raid encounters except
relog, and permanent-bind mismatches. Generic access checks still apply.

Entry creates/resolves `InstanceSave`, validates binds, creates group/player
bind, cancels empty reset, delegates to `Map::AddPlayerToMap()`, and calls
`InstanceScript::OnPlayerEnter()`.

### InstanceScript state

`InstanceScript` coordinates encounters, doors, minions, object GUIDs,
boundaries, and spawn groups. `SetBossState()` treats initial
`TO_BE_DECIDED` as loading, rejects no-op/backward-from-`DONE` changes, refuses
`DONE` while configured world-boss minions live, saves, and updates dependents.

`SaveToDB()` serializes headers, boss states, custom data, and completion mask,
then submits `CHAR_UPD_INSTANCE_DATA` asynchronously without a transaction.
Load converts `IN_PROGRESS`, `FAIL`, and `SPECIAL` to `NOT_STARTED`. Custom
serialization needs stable headers, defensive parsing, and restart tests.

`InstanceMap::CreateInstanceData(load=true)` performs a synchronous characters
query in this snapshot. Avoid adding blocking work to instance creation without
measuring latency.

## Map transports

A map `Transport` is a moving gameobject route, distinct from a unit-attached
`Vehicle` covered in `06-spells-combat-ai-movement.md`.

`TransportMgr::LoadTransportTemplates()` derives cyclic keyframes, splines,
stop/acceleration timing, map transitions, and events from templates and taxi
nodes. Runtime tracks keyframes, dynamic/static passengers, stop/movement,
delayed teleport, collision, and route events.

Dynamic passengers retain local offsets. Static passengers load only in
active grids. Cross-map travel sets delayed state during concurrent update,
then `Map::DelayedUpdate()` removes the transport from the old map, teleports
supported passengers, relocates, and adds it to the new map.

Use `TransportBase` for local/world coordinate transforms. Test stops, events,
grid activation, nested vehicles, logout, and every map transition.

## Groups, guilds, and channels

### Groups

`Group::MemberSlotList` is stable membership including offline players.
`GroupRefManager` links connected players. Do not iterate references when an
operation applies to offline members, and do not assume every slot has a live
`Player*`. Membership, leadership, subgroup, loot, difficulty, LFG, and
instance binds are coupled.

### Guilds

`Guild` coordinates members, ranks/rights, bank items/money, withdrawal limits,
logs, and DB persistence. Bank movement uses transaction-aware `MoveItemData`
implementations. Recheck membership, rights, target rank, bank access,
capacity, money, and item eligibility at mutation time; preserve transaction
and event-log coupling.

### Channels

`ChannelMgr` owns custom and built-in channels. Built-ins key by DBC channel
and zone; custom channels use normalized names. `ChannelMgr::ForTeam()` selects
faction managers unless cross-faction channels are enabled.

With `PreserveCustomChannels`, custom state loads/saves to characters DB.
Logout must remove live membership even when channel state persists.

## Mail

`MailDraft::SendMailTo()` supports online/offline receivers and expects a
caller-supplied character transaction. It appends mail and attachment rows,
computes delivery/expiry, and updates an online receiver's runtime list.

Attachment transfer must preserve source removal, item owner/save, mail rows,
money/COD, delivery delay, and offline attachment object cleanup. Online state
changes before queued persistence is known durable; do not treat submission as
confirmed persistence.

## Auctions

`AuctionHouseMgr` owns faction/neutral `AuctionHouseObject`s, auction maps,
auction-held items, bidder indexes, and pending deposits. Startup loads items
before entries and cleans invalid/expired state. Update expires auctions and
settles them by mail.

Sell, bid/buyout, and cancel handlers revalidate auctioneer, house, ownership,
trade eligibility, stacks, duplicate GUIDs, prices/deposits, identity, and
current state. They coordinate live manager state, inventory/money, DB rows,
and mail. Preserve established ordering.

Some split-stack sale branches use multiple character transactions in this
snapshot; review partial-failure and shutdown behavior before restructuring.
All auction handlers are world-side to serialize realm-wide collections.

## LFG

`LFGMgr` owns player/group state, queues, roles, proposals, vote kicks,
dungeons, teleports, completion, and rewards.

`MakeNewGroup()` resolves players, removes conflicting groups, creates/reuses
an LFG group, assigns roles/difficulty, persists, teleports eligible members,
and sends updates.

`TeleportPlayer()` validates group/dungeon, life, movement/fatigue, vehicle,
charm, map, and entry point. `FinishDungeon()` prevents duplicate rewards,
requires the completing map, and grants random/seasonal rewards through quests.

Mutating LFG opcodes and `LFGMgr::Update()` are world-side. Never mutate queue
or proposal state from an arbitrary map callback.

## Battlegrounds and OutdoorPvP

`BattlegroundMgr` owns templates, live matches, queues, free slots, and
scheduled updates. `BattlegroundMap` owns simulation; `Battleground` owns
rules, teams, scores, timers, and objectives.

`OutdoorPvPMgr` owns zone scripts and receives player enter/leave events; its
periodic update is world-side after the map barrier.

Keep movement/combat/live units map-owned, allocation/queues manager-owned,
and scripts coordinated at documented update points. Logout must remove
invitations, queues, flags, and zone participation before deleting a player.

## Safe change workflows

### Map-local behavior

1. Identify owner map and packet/callback context.
2. Resolve templates through `ObjectMgr`, live objects through the map.
3. Set GUID, map, phase, and position before `Map::AddToMap()`.
4. Use map relocation and visibility APIs.
5. Store GUIDs/weak references across delayed work.
6. Queue removal instead of deleting an in-world object.
7. Test unload/reload, despawn, teleport, phase, and logout.

### Persistent player state

1. Define in-memory owner and default/reset value.
2. Add character migration and prepared statements.
3. Extend login load, including holder indexes.
4. Add mutation APIs and dirty tracking.
5. Append saves to the player transaction.
6. Define offline behavior.
7. Test creation, login, autosave, logout, restart, and far teleport.

### Quest or loot

Validate templates/references at startup and interaction at request time,
revalidate before reward/storage, use inventory validators/destinations,
preserve group/achievement/script effects, and test full inventory, duplicate
requests, source despawn, disconnect, and restart.

### Instance

Define encounter IDs and boss count, register doors/minions/objects/boundaries,
use `SetBossState()`, version serialization, and test bind priority, reset,
extension, unload, recreation, and restart from every meaningful state.

### Economy transfer

Revalidate actor/NPC/source/ownership/capacity/money, identify all in-memory
and DB owners, reuse one transaction where atomic order matters, avoid using
deleted items, handle online/offline recipients, and test duplicate packets,
shutdown backlog, insufficient resources, and split stacks.

## Validation and hazards

Exercise map workers off/one/many, simultaneous maps, grid unload/reload,
spawn/despawn/phase/deferred removal, login/transfer/logout/restart, full
inventory, online/offline groups, instance bind/reset combinations, LFG
failure/duplicate completion, auction/mail counterparts, and PvP logout.

Useful categories include `maps`, `entities.player`,
`entities.player.items`, `entities.transport`, `entities.vehicle`, `lfg.*`,
`network`, `sql.sql`, and `server.loading`.

High-risk invariants:

- Maps can run concurrently; global lookup does not grant mutation safety.
- `ObjectAccessor` pointers are raw and non-owning.
- Deferred removal begins cleanup before deletion.
- Grid unload invalidates runtime objects while templates remain.
- Direct position writes bypass cell, visibility, collision, and transport
  bookkeeping.
- Active flags/grid locks can prevent unloading indefinitely.
- Login holders are batched reads, not transactions.
- Normal commits and instance saves are asynchronous.
- Far-teleport saves are delayed.
- Item state transitions can immediately delete an item.
- Instance saves and loaded maps have separate lifetimes.
- Realm-wide auction/LFG/group state belongs world-side.
- Mail/auction mutate memory before persistence is known durable.
- No transaction spans login, characters, and world databases.

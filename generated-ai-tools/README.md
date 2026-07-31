# Forgekeeper

Local-network creature authoring for TrinityCore 3.3.5. The Go API reads and writes the live `world` database; the Next.js UI provides creature search, field guidance, display metadata, gossip, creature text, SmartAI, equipment, spells, resistances, movement, and spawn inspection.

Use **New Creature** to either clone an existing template or start from validated safe defaults without a source template. Blank creation requires a real display and faction from the local DBC files, a supported creature class, and a valid level range.

## Start

Docker is the only local prerequisite:

```bash
mkdir -p model-cache
docker compose up --build
```

Open `http://localhost:3000`. Other machines on the LAN can use `http://<server-ip>:3000`; the browser connects to the API on the same host at port `8080`.

The default database connection matches `worldserver.conf.dist`: `trinity:trinity@host.docker.internal:3306/world`. Override values by copying `.env.example` to `.env` and editing it.

## Safety

- Writes are enabled by default in `compose.yaml` because this is an authoring tool. Set `DB_WRITE_ENABLED=false` for inspection-only use.
- There is no authentication. Do not expose ports 3000 or 8080 outside a trusted local network.
- Related rows are replaced transactionally when their section is saved. Creature template fields are updated in place.
- Gossip menu IDs can be shared. The UI warns before editing a menu, since changes affect all creatures that reference it.
- Restart the worldserver after DB changes, or use the appropriate TrinityCore reload commands where supported.

## Creature model pipeline

The API resolves display IDs through local `CreatureDisplayInfo.dbc` and `CreatureModelData.dbc`. TrinityCore does not ship visual models, and extracted VMAP files are collision data, not renderable assets.

Convert one or more display IDs from the locally installed 3.3.5a client:

```bash
./convert-model 782
./convert-model 169 26656
```

The command builds its converter container when needed, resolves each display through the local DBC files, searches MPQs in TrinityCore patch precedence, extracts the M2, highest-detail `00.skin`, and selected BLP textures, and writes an embedded-texture GLB plus JSON manifest into `model-cache/`. Refresh the model card after conversion; the API serves the GLB and the Three.js viewer frames it automatically.

Configure non-default paths in `.env`:

```dotenv
DBC_PATH=/home/user/server/dbc
WOW_CLIENT_PATH=/home/user/World of Warcraft 3.3.5a
WOW_LOCALE=enUS
```

The converter intentionally has a defined scope:

- It exports static bind-pose geometry, normals, UVs, skin sections, materials, and ordinary creature textures.
- It supports WotLK M2 version 264, BLP1/BLP2 formats supported by Pillow, and display-specific creature texture slots 11 through 13.
- It approximates WoW additive/modulate materials with standard glTF alpha blending and records warnings in `<display-id>.json`.
- It uses only the first operation in a multitexture batch because core glTF cannot represent WoW's texture combiner directly.
- It does not yet export skeletal animations, particles, ribbons, or billboard effects.
- `CreatureDisplayInfoExtra` humanoids use their baked NPC body/clothing texture, selected hair texture, customization geosets, and clothing geosets. This supports ordinary NPCs such as display `1291`.
- Separate equipment attachment models, most notably some helms, shoulders, and capes, are not assembled yet. The conversion still succeeds and records omitted item display IDs as warnings in `<display-id>.json`.
- `--allow-composite` is available through `docker compose run --rm converter --allow-composite ID` for rare humanoid records that have no baked NPC texture.

Client assets and converted GLBs remain copyrighted game content. Keep `model-cache/` local and do not commit or redistribute it.

## API

- `GET /api/health`
- `GET /api/meta`
- `GET /api/creatures?q=innkeeper`
- `POST /api/creatures` (create from validated safe defaults or clone an existing template)
- `GET /api/creatures/{entry}`
- `PUT /api/creatures/{entry}`
- `PUT /api/creatures/{entry}/related/{template-addon|movement|resistances|spells|equipment|texts|smart}`
- `PUT /api/gossip/{menu}`
- `GET /api/displays/{displayId}`

## Current scope

Spawn records are shown read-only until map/coordinate validation is implemented. SmartAI preserves every schema parameter and includes gossip presets; a later iteration should generate event/action-specific parameter labels from TrinityCore's `SmartScriptMgr.h` and add a visual condition builder.

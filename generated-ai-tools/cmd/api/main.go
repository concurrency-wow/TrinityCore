package main

import (
	"context"
	"database/sql"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	_ "github.com/go-sql-driver/mysql"
)

type api struct {
	db           *sql.DB
	writeEnabled bool
	dbc          *dbcStore
	modelCache   string
}

type dbcStore struct {
	displays map[uint32]displayInfo
	models   map[uint32]modelInfo
	factions map[uint32]bool
	err      string
}

type displayInfo struct {
	DisplayID             uint32   `json:"displayId"`
	ModelID               uint32   `json:"modelId"`
	ExtendedDisplayInfoID uint32   `json:"extendedDisplayInfoId"`
	Scale                 float32  `json:"scale"`
	Textures              []string `json:"textures"`
}

type modelInfo struct {
	ModelID uint32  `json:"modelId"`
	Flags   uint32  `json:"flags"`
	Path    string  `json:"path"`
	Scale   float32 `json:"scale"`
	Height  float32 `json:"collisionHeight"`
	Mount   float32 `json:"mountHeight"`
}

var templateColumns = []string{
	"difficulty_entry_1", "difficulty_entry_2", "difficulty_entry_3", "KillCredit1", "KillCredit2",
	"modelid1", "modelid2", "modelid3", "modelid4", "name", "subname", "IconName", "gossip_menu_id",
	"minlevel", "maxlevel", "exp", "faction", "npcflag", "speed_walk", "speed_run", "scale", "rank",
	"dmgschool", "BaseAttackTime", "RangeAttackTime", "BaseVariance", "RangeVariance", "unit_class", "unit_flags",
	"unit_flags2", "dynamicflags", "family", "type", "type_flags", "lootid", "pickpocketloot", "skinloot",
	"PetSpellDataId", "VehicleId", "mingold", "maxgold", "AIName", "MovementType", "HoverHeight", "HealthModifier",
	"ManaModifier", "ArmorModifier", "DamageModifier", "ExperienceModifier", "RacialLeader", "movementId", "RegenHealth",
	"mechanic_immune_mask", "spell_school_immune_mask", "flags_extra", "ScriptName", "StringId", "VerifiedBuild",
}

type relatedSpec struct {
	table        string
	scopeColumn  string
	columns      []string
	single       bool
	deleteSource string
}

var related = map[string]relatedSpec{
	"template-addon": {"creature_template_addon", "entry", []string{"path_id", "mount", "StandState", "AnimTier", "VisFlags", "SheathState", "PvPFlags", "emote", "visibilityDistanceType", "auras"}, true, ""},
	"movement":       {"creature_template_movement", "CreatureId", []string{"Ground", "Swim", "Flight", "Rooted", "Chase", "Random", "InteractionPauseTimer"}, true, ""},
	"resistances":    {"creature_template_resistance", "CreatureID", []string{"School", "Resistance", "VerifiedBuild"}, false, ""},
	"spells":         {"creature_template_spell", "CreatureID", []string{"Index", "Spell", "VerifiedBuild"}, false, ""},
	"equipment":      {"creature_equip_template", "CreatureID", []string{"ID", "ItemID1", "ItemID2", "ItemID3", "VerifiedBuild"}, false, ""},
	"texts":          {"creature_text", "CreatureID", []string{"GroupID", "ID", "Text", "Type", "Language", "Probability", "Emote", "Duration", "Sound", "BroadcastTextId", "TextRange", "comment"}, false, ""},
	"smart":          {"smart_scripts", "entryorguid", []string{"source_type", "id", "link", "event_type", "event_phase_mask", "event_chance", "event_flags", "event_param1", "event_param2", "event_param3", "event_param4", "event_param5", "action_type", "action_param1", "action_param2", "action_param3", "action_param4", "action_param5", "action_param6", "target_type", "target_param1", "target_param2", "target_param3", "target_param4", "target_x", "target_y", "target_z", "target_o", "comment"}, false, "source_type = 0"},
}

func main() {
	host, port := env("DB_HOST", "127.0.0.1"), env("DB_PORT", "3306")
	dsn := fmt.Sprintf("%s:%s@tcp(%s:%s)/%s?charset=utf8mb4&parseTime=true&timeout=5s", env("DB_USER", "trinity"), env("DB_PASSWORD", "trinity"), host, port, env("DB_NAME", "world"))
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		log.Fatal(err)
	}
	db.SetConnMaxLifetime(3 * time.Minute)
	db.SetMaxOpenConns(12)
	db.SetMaxIdleConns(4)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		log.Fatalf("world database: %v", err)
	}

	app := &api{db: db, writeEnabled: strings.EqualFold(env("DB_WRITE_ENABLED", "false"), "true"), dbc: loadDBCs(env("DBC_PATH", "/home/czirz/server/dbc")), modelCache: env("MODEL_CACHE_PATH", "./model-cache")}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", app.health)
	mux.HandleFunc("GET /api/meta", app.meta)
	mux.HandleFunc("GET /api/creatures", app.searchCreatures)
	mux.HandleFunc("POST /api/creatures", app.createCreature)
	mux.HandleFunc("GET /api/creatures/{entry}", app.getCreature)
	mux.HandleFunc("PUT /api/creatures/{entry}", app.putCreature)
	mux.HandleFunc("PUT /api/creatures/{entry}/related/{resource}", app.putRelated)
	mux.HandleFunc("PUT /api/gossip/{menu}", app.putGossip)
	mux.HandleFunc("GET /api/displays/{id}", app.getDisplay)
	mux.HandleFunc("GET /models/", app.serveModel)

	addr := ":" + env("API_PORT", "8080")
	log.Printf("Trinity Tools API listening on %s (writes=%t, dbcRecords=%d)", addr, app.writeEnabled, len(app.dbc.displays))
	log.Fatal(http.ListenAndServe(addr, cors(logging(mux))))
}

func env(k, fallback string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return fallback
}

func (a *api) health(w http.ResponseWriter, r *http.Request) {
	var version, database string
	err := a.db.QueryRowContext(r.Context(), "SELECT VERSION(), DATABASE()").Scan(&version, &database)
	if err != nil {
		fail(w, 503, err)
		return
	}
	writeJSON(w, 200, map[string]any{"status": "ok", "database": database, "mysqlVersion": version, "writeEnabled": a.writeEnabled, "dbcLoaded": len(a.dbc.displays), "dbcError": a.dbc.err})
}

func (a *api) meta(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, 200, map[string]any{
		"writeEnabled":      a.writeEnabled,
		"creatureTypes":     options([]any{0, "None", 1, "Beast", 2, "Dragonkin", 3, "Demon", 4, "Elemental", 5, "Giant", 6, "Undead", 7, "Humanoid", 8, "Critter", 9, "Mechanical", 10, "Not specified", 11, "Totem", 12, "Non-combat pet", 13, "Gas cloud"}),
		"ranks":             options([]any{0, "Normal", 1, "Elite", 2, "Rare Elite", 3, "World Boss", 4, "Rare", 5, "Unknown"}),
		"classes":           options([]any{1, "Warrior", 2, "Paladin", 4, "Rogue", 8, "Mage"}),
		"movementTypes":     options([]any{0, "Idle", 1, "Random", 2, "Waypoint"}),
		"genders":           options([]any{0, "Male", 1, "Female", 2, "None"}),
		"gossipOptionTypes": options([]any{0, "None", 1, "Gossip", 2, "Questgiver", 3, "Vendor", 4, "Taxi", 5, "Trainer", 6, "Spirit healer", 7, "Spirit guide", 8, "Innkeeper", 9, "Banker", 10, "Petitioner", 11, "Tabard designer", 12, "Battlemaster", 13, "Auctioneer", 14, "Stable master", 15, "Armorer", 16, "Unlearn talents", 17, "Unlearn pet talents", 18, "Learn dual spec", 19, "Outdoor PvP"}),
		"smartEvents":       options([]any{0, "Update IC", 1, "Update OOC", 2, "Health percentage", 4, "Aggro", 5, "Kill", 6, "Death", 7, "Evade", 8, "Spell hit", 9, "Range", 11, "Respawn", 19, "Quest accepted", 20, "Quest rewarded", 25, "Reset", 60, "Update", 61, "Link", 62, "Gossip select", 64, "Gossip hello"}),
		"smartActions":      options([]any{1, "Talk", 5, "Emote", 11, "Cast", 12, "Summon creature", 17, "Set unit flag", 18, "Remove unit flag", 21, "Set combat movement", 22, "Set event phase", 25, "Flee for assist", 33, "Call killed monster", 41, "Despawn", 45, "Set data", 53, "Start waypoint", 71, "Equip", 80, "Call timed action list", 84, "Simple talk", 85, "Invoker cast", 124, "Load equipment"}),
		"smartTargets":      options([]any{0, "None", 1, "Self", 2, "Victim", 3, "Hostile second aggro", 4, "Hostile last aggro", 5, "Hostile random", 7, "Invoker", 8, "Position", 9, "Creature range", 10, "Creature GUID", 11, "Creature distance", 12, "Stored", 19, "Closest creature", 21, "Closest player", 23, "Invoker party", 25, "Owner or summoner", 30, "Closest enemy"}),
	})
}

func options(v []any) []map[string]any {
	r := make([]map[string]any, 0, len(v)/2)
	for i := 0; i < len(v); i += 2 {
		r = append(r, map[string]any{"value": v[i], "label": v[i+1]})
	}
	return r
}

func (a *api) searchCreatures(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	limit := clamp(parseInt(r.URL.Query().Get("limit"), 40), 1, 100)
	args := []any{}
	where := "1=1"
	if q != "" {
		if id, err := strconv.ParseUint(q, 10, 32); err == nil {
			where = "entry = ? OR name LIKE ?"
			args = append(args, id, "%"+q+"%")
		} else {
			where = "name LIKE ? OR subname LIKE ?"
			args = append(args, "%"+q+"%", "%"+q+"%")
		}
	}
	args = append(args, limit)
	rows, err := queryRows(r.Context(), a.db, `SELECT entry,name,subname,minlevel,maxlevel,`+"`rank`,`type`"+`,faction,modelid1,modelid2,modelid3,modelid4,gossip_menu_id,AIName,(SELECT COUNT(*) FROM creature c WHERE c.id=creature_template.entry) spawn_count FROM creature_template WHERE `+where+` ORDER BY IF(name LIKE ?,0,1), entry LIMIT ?`, append(args[:len(args)-1], q+"%", args[len(args)-1])...)
	if err != nil {
		fail(w, 500, err)
		return
	}
	writeJSON(w, 200, map[string]any{"items": rows})
}

func (a *api) createCreature(w http.ResponseWriter, r *http.Request) {
	if !a.requireWrite(w) {
		return
	}
	var body struct {
		Entry     uint64 `json:"entry"`
		CloneFrom uint64 `json:"cloneFrom"`
		Name      string `json:"name"`
		Subname   string `json:"subname"`
		DisplayID uint64 `json:"displayId"`
		Faction   uint64 `json:"faction"`
		MinLevel  uint64 `json:"minLevel"`
		MaxLevel  uint64 `json:"maxLevel"`
		Rank      uint64 `json:"rank"`
		Type      uint64 `json:"type"`
		UnitClass uint64 `json:"unitClass"`
	}
	if err := decode(r, &body); err != nil {
		fail(w, 400, err)
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if body.Entry == 0 || body.Entry > math.MaxUint32 {
		fail(w, 400, errors.New("entry must be between 1 and 4294967295"))
		return
	}
	if body.Name == "" || len(body.Name) > 100 {
		fail(w, 400, errors.New("name must contain 1 to 100 characters"))
		return
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 500, err)
		return
	}
	defer tx.Rollback()
	if body.CloneFrom > 0 {
		quoted := make([]string, len(templateColumns))
		for i, c := range templateColumns {
			quoted[i] = "`" + c + "`"
		}
		q := "INSERT INTO creature_template (`entry`," + strings.Join(quoted, ",") + ") SELECT ?," + strings.Join(quoted, ",") + " FROM creature_template WHERE entry=?"
		res, execErr := tx.ExecContext(r.Context(), q, body.Entry, body.CloneFrom)
		if execErr != nil {
			fail(w, 422, execErr)
			return
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			fail(w, 404, errors.New("source creature was not found"))
			return
		}
		if _, err = tx.ExecContext(r.Context(), "UPDATE creature_template SET name=?, subname=NULL, gossip_menu_id=0, lootid=0, pickpocketloot=0, skinloot=0, ScriptName='', StringId=NULL, VerifiedBuild=0 WHERE entry=?", body.Name, body.Entry); err != nil {
			fail(w, 422, err)
			return
		}
	} else {
		if body.DisplayID == 0 || a.dbc.displays[uint32(body.DisplayID)].DisplayID == 0 {
			fail(w, 422, errors.New("displayId is not present in CreatureDisplayInfo.dbc"))
			return
		}
		if !a.dbc.factions[uint32(body.Faction)] {
			fail(w, 422, errors.New("faction is not present in FactionTemplate.dbc"))
			return
		}
		if body.MinLevel < 1 || body.MaxLevel > 255 || body.MinLevel > body.MaxLevel {
			fail(w, 422, errors.New("levels must be between 1 and 255 and minLevel cannot exceed maxLevel"))
			return
		}
		if body.UnitClass != 1 && body.UnitClass != 2 && body.UnitClass != 4 && body.UnitClass != 8 {
			fail(w, 422, errors.New("unitClass must be Warrior (1), Paladin (2), Rogue (4), or Mage (8)"))
			return
		}
		if body.Type > 13 || body.Rank > 5 {
			fail(w, 422, errors.New("invalid creature type or rank"))
			return
		}
		_, err = tx.ExecContext(r.Context(), `INSERT INTO creature_template (entry,name,subname,modelid1,minlevel,maxlevel,faction,rank,unit_class,`+"`type`"+`,BaseAttackTime,RangeAttackTime,AIName,VerifiedBuild) VALUES (?,?,?,?,?,?,?,?,?,?,2000,2000,'',0)`, body.Entry, body.Name, nullString(body.Subname), body.DisplayID, body.MinLevel, body.MaxLevel, body.Faction, body.Rank, body.UnitClass, body.Type)
		if err != nil {
			fail(w, 422, err)
			return
		}
	}
	if err = tx.Commit(); err != nil {
		fail(w, 500, err)
		return
	}
	writeJSON(w, 201, map[string]any{"created": true, "entry": body.Entry, "clonedFrom": body.CloneFrom})
}

func (a *api) getCreature(w http.ResponseWriter, r *http.Request) {
	entry, err := pathUint(r, "entry")
	if err != nil {
		fail(w, 400, err)
		return
	}
	tpl, err := queryOne(r.Context(), a.db, "SELECT * FROM creature_template WHERE entry=?", entry)
	if errors.Is(err, sql.ErrNoRows) {
		fail(w, 404, errors.New("creature not found"))
		return
	}
	if err != nil {
		fail(w, 500, err)
		return
	}

	queries := map[string]struct {
		q    string
		args []any
	}{
		"modelInfo":       {`SELECT * FROM creature_model_info WHERE DisplayID IN (?,?,?,?)`, []any{tpl["modelid1"], tpl["modelid2"], tpl["modelid3"], tpl["modelid4"]}},
		"spawns":          {`SELECT * FROM creature WHERE id=? ORDER BY guid LIMIT 500`, []any{entry}},
		"templateAddon":   {`SELECT * FROM creature_template_addon WHERE entry=?`, []any{entry}},
		"movement":        {`SELECT * FROM creature_template_movement WHERE CreatureId=?`, []any{entry}},
		"resistances":     {`SELECT * FROM creature_template_resistance WHERE CreatureID=? ORDER BY School`, []any{entry}},
		"spells":          {`SELECT * FROM creature_template_spell WHERE CreatureID=? ORDER BY ` + "`Index`", []any{entry}},
		"equipment":       {`SELECT * FROM creature_equip_template WHERE CreatureID=? ORDER BY ID`, []any{entry}},
		"texts":           {`SELECT * FROM creature_text WHERE CreatureID=? ORDER BY GroupID,ID`, []any{entry}},
		"smart":           {`SELECT * FROM smart_scripts WHERE entryorguid=? AND source_type=0 ORDER BY id,link`, []any{entry}},
		"smartConditions": {`SELECT * FROM conditions WHERE SourceTypeOrReferenceId=22 AND SourceEntry=? AND SourceId=0 ORDER BY SourceGroup,ElseGroup`, []any{entry}},
	}
	doc := map[string]any{"template": tpl}
	for name, item := range queries {
		rows, e := queryRows(r.Context(), a.db, item.q, item.args...)
		if e != nil {
			fail(w, 500, fmt.Errorf("%s: %w", name, e))
			return
		}
		doc[name] = rows
	}
	menu := toUint64(tpl["gossip_menu_id"])
	if menu > 0 {
		pages, _ := queryRows(r.Context(), a.db, `SELECT gm.*, nt.text0_0,nt.text0_1,nt.BroadcastTextID0 FROM gossip_menu gm LEFT JOIN npc_text nt ON nt.ID=gm.TextID WHERE gm.MenuID=? ORDER BY gm.TextID`, menu)
		opts, _ := queryRows(r.Context(), a.db, `SELECT * FROM gossip_menu_option WHERE MenuID=? ORDER BY OptionID`, menu)
		doc["gossip"] = map[string]any{"menuId": menu, "pages": pages, "options": opts}
	} else {
		doc["gossip"] = map[string]any{"menuId": 0, "pages": []any{}, "options": []any{}}
	}
	writeJSON(w, 200, doc)
}

func (a *api) putCreature(w http.ResponseWriter, r *http.Request) {
	if !a.requireWrite(w) {
		return
	}
	entry, err := pathUint(r, "entry")
	if err != nil {
		fail(w, 400, err)
		return
	}
	var body struct {
		Template map[string]any `json:"template"`
	}
	if err := decode(r, &body); err != nil {
		fail(w, 400, err)
		return
	}
	if len(body.Template) == 0 {
		fail(w, 400, errors.New("template is required"))
		return
	}
	allowed := set(templateColumns)
	parts, args := []string{}, []any{}
	for _, c := range templateColumns {
		if v, ok := body.Template[c]; ok && allowed[c] {
			parts = append(parts, "`"+c+"`=?")
			args = append(args, jsonValue(v))
		}
	}
	if len(parts) == 0 {
		fail(w, 400, errors.New("no editable fields"))
		return
	}
	if min, ok := numeric(body.Template["minlevel"]); ok {
		if max, ok := numeric(body.Template["maxlevel"]); ok && min > max {
			fail(w, 422, errors.New("minlevel cannot exceed maxlevel"))
			return
		}
	}
	if min, ok := numeric(body.Template["mingold"]); ok {
		if max, ok := numeric(body.Template["maxgold"]); ok && min > max {
			fail(w, 422, errors.New("mingold cannot exceed maxgold"))
			return
		}
	}
	args = append(args, entry)
	res, err := a.db.ExecContext(r.Context(), "UPDATE creature_template SET "+strings.Join(parts, ",")+" WHERE entry=?", args...)
	if err != nil {
		fail(w, 422, err)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		fail(w, 404, errors.New("creature not found or unchanged"))
		return
	}
	writeJSON(w, 200, map[string]any{"saved": true, "entry": entry})
}

func (a *api) putRelated(w http.ResponseWriter, r *http.Request) {
	if !a.requireWrite(w) {
		return
	}
	entry, err := pathUint(r, "entry")
	if err != nil {
		fail(w, 400, err)
		return
	}
	spec, ok := related[r.PathValue("resource")]
	if !ok {
		fail(w, 404, errors.New("unknown related resource"))
		return
	}
	var body struct {
		Rows []map[string]any `json:"rows"`
	}
	if err := decode(r, &body); err != nil {
		fail(w, 400, err)
		return
	}
	if spec.single && len(body.Rows) > 1 {
		fail(w, 400, errors.New("resource accepts at most one row"))
		return
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 500, err)
		return
	}
	defer tx.Rollback()
	del := fmt.Sprintf("DELETE FROM `%s` WHERE `%s`=?", spec.table, spec.scopeColumn)
	if spec.deleteSource != "" {
		del += " AND " + spec.deleteSource
	}
	if _, err = tx.ExecContext(r.Context(), del, entry); err != nil {
		fail(w, 422, err)
		return
	}
	cols := append([]string{spec.scopeColumn}, spec.columns...)
	marks := strings.TrimSuffix(strings.Repeat("?,", len(cols)), ",")
	insert := "INSERT INTO `" + spec.table + "` (`" + strings.Join(cols, "`,`") + "`) VALUES (" + marks + ")"
	for _, row := range body.Rows {
		vals := []any{entry}
		for _, c := range spec.columns {
			vals = append(vals, jsonValue(row[c]))
		}
		if _, err = tx.ExecContext(r.Context(), insert, vals...); err != nil {
			fail(w, 422, fmt.Errorf("%s row: %w", spec.table, err))
			return
		}
	}
	if err = tx.Commit(); err != nil {
		fail(w, 500, err)
		return
	}
	writeJSON(w, 200, map[string]any{"saved": true, "resource": r.PathValue("resource"), "rows": len(body.Rows)})
}

func (a *api) putGossip(w http.ResponseWriter, r *http.Request) {
	if !a.requireWrite(w) {
		return
	}
	menu, err := pathUint(r, "menu")
	if err != nil || menu > 65535 {
		fail(w, 400, errors.New("invalid gossip menu ID"))
		return
	}
	var body struct {
		Pages   []map[string]any `json:"pages"`
		Options []map[string]any `json:"options"`
	}
	if err := decode(r, &body); err != nil {
		fail(w, 400, err)
		return
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 500, err)
		return
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(r.Context(), "DELETE FROM gossip_menu WHERE MenuID=?", menu); err != nil {
		fail(w, 422, err)
		return
	}
	if _, err = tx.ExecContext(r.Context(), "DELETE FROM gossip_menu_option WHERE MenuID=?", menu); err != nil {
		fail(w, 422, err)
		return
	}
	for _, p := range body.Pages {
		textID := jsonValue(p["TextID"])
		if textID == nil {
			fail(w, 400, errors.New("each gossip page requires TextID"))
			return
		}
		if _, err = tx.ExecContext(r.Context(), "INSERT INTO gossip_menu (MenuID,TextID,VerifiedBuild) VALUES (?,?,?)", menu, textID, defaultValue(p["VerifiedBuild"], 0)); err != nil {
			fail(w, 422, err)
			return
		}
		if text, ok := p["text0_0"]; ok {
			if _, err = tx.ExecContext(r.Context(), "INSERT INTO npc_text (ID,text0_0,text0_1,BroadcastTextID0,Probability0) VALUES (?,?,?,?,1) ON DUPLICATE KEY UPDATE text0_0=VALUES(text0_0),text0_1=VALUES(text0_1),BroadcastTextID0=VALUES(BroadcastTextID0)", textID, jsonValue(text), defaultValue(p["text0_1"], ""), defaultValue(p["BroadcastTextID0"], 0)); err != nil {
				fail(w, 422, err)
				return
			}
		}
	}
	optionCols := []string{"OptionID", "OptionIcon", "OptionText", "OptionBroadcastTextID", "OptionType", "OptionNpcFlag", "ActionMenuID", "ActionPoiID", "BoxCoded", "BoxMoney", "BoxText", "BoxBroadcastTextID", "VerifiedBuild"}
	marks := strings.TrimSuffix(strings.Repeat("?,", len(optionCols)+1), ",")
	q := "INSERT INTO gossip_menu_option (MenuID,`" + strings.Join(optionCols, "`,`") + "`) VALUES (" + marks + ")"
	for _, o := range body.Options {
		vals := []any{menu}
		for _, c := range optionCols {
			fallback := any(0)
			if c == "OptionText" || c == "BoxText" {
				fallback = ""
			}
			vals = append(vals, defaultValue(o[c], fallback))
		}
		if _, err = tx.ExecContext(r.Context(), q, vals...); err != nil {
			fail(w, 422, err)
			return
		}
	}
	if err = tx.Commit(); err != nil {
		fail(w, 500, err)
		return
	}
	writeJSON(w, 200, map[string]any{"saved": true, "menuId": menu})
}

func (a *api) getDisplay(w http.ResponseWriter, r *http.Request) {
	id, err := pathUint(r, "id")
	if err != nil {
		fail(w, 400, err)
		return
	}
	d, ok := a.dbc.displays[uint32(id)]
	if !ok {
		fail(w, 404, errors.New("display ID is not present in CreatureDisplayInfo.dbc"))
		return
	}
	m := a.dbc.models[d.ModelID]
	glb := filepath.Join(a.modelCache, strconv.FormatUint(id, 10)+".glb")
	_, statErr := os.Stat(glb)
	writeJSON(w, 200, map[string]any{"display": d, "model": m, "renderClass": map[bool]string{true: "composite-humanoid", false: "simple-creature"}[d.ExtendedDisplayInfoID != 0], "renderUrl": func() any {
		if statErr == nil {
			return "/models/" + strconv.FormatUint(id, 10) + ".glb"
		}
		return nil
	}(), "renderStatus": map[bool]string{true: "ready", false: "conversion-required"}[statErr == nil]})
}

func (a *api) serveModel(w http.ResponseWriter, r *http.Request) {
	name := filepath.Base(strings.TrimPrefix(r.URL.Path, "/models/"))
	if !strings.HasSuffix(name, ".glb") {
		http.NotFound(w, r)
		return
	}
	http.ServeFile(w, r, filepath.Join(a.modelCache, name))
}

func loadDBCs(dir string) *dbcStore {
	s := &dbcStore{displays: map[uint32]displayInfo{}, models: map[uint32]modelInfo{}, factions: map[uint32]bool{}}
	dh, dr, ds, err := readDBC(filepath.Join(dir, "CreatureDisplayInfo.dbc"))
	if err != nil {
		s.err = err.Error()
		return s
	}
	if dh.fields < 16 {
		s.err = "CreatureDisplayInfo.dbc has an unexpected layout"
		return s
	}
	for _, row := range dr {
		id := u32(row, 0)
		textures := []string{}
		for _, f := range []int{6, 7, 8} {
			if v := dbcString(ds, u32(row, f)); v != "" {
				textures = append(textures, v)
			}
		}
		s.displays[id] = displayInfo{id, u32(row, 1), u32(row, 3), f32(row, 4), textures}
	}
	mh, mr, ms, err := readDBC(filepath.Join(dir, "CreatureModelData.dbc"))
	if err != nil {
		s.err = err.Error()
		return s
	}
	if mh.fields < 17 {
		s.err = "CreatureModelData.dbc has an unexpected layout"
		return s
	}
	for _, row := range mr {
		id := u32(row, 0)
		p := strings.ReplaceAll(dbcString(ms, u32(row, 2)), "\\", "/")
		if strings.HasSuffix(strings.ToLower(p), ".mdx") {
			p = p[:len(p)-4] + ".m2"
		}
		s.models[id] = modelInfo{id, u32(row, 1), p, f32(row, 4), f32(row, 15), f32(row, 16)}
	}
	_, fr, _, err := readDBC(filepath.Join(dir, "FactionTemplate.dbc"))
	if err != nil {
		s.err = err.Error()
		return s
	}
	for _, row := range fr {
		s.factions[u32(row, 0)] = true
	}
	return s
}

type dbcHeader struct{ records, fields, recordSize, stringSize uint32 }

func readDBC(path string) (dbcHeader, [][]byte, []byte, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return dbcHeader{}, nil, nil, err
	}
	if len(b) < 20 || string(b[:4]) != "WDBC" {
		return dbcHeader{}, nil, nil, fmt.Errorf("%s is not a WDBC file", path)
	}
	h := dbcHeader{binary.LittleEndian.Uint32(b[4:8]), binary.LittleEndian.Uint32(b[8:12]), binary.LittleEndian.Uint32(b[12:16]), binary.LittleEndian.Uint32(b[16:20])}
	end := 20 + int(h.records*h.recordSize)
	if end > len(b) {
		return h, nil, nil, errors.New("truncated DBC")
	}
	rows := make([][]byte, 0, h.records)
	for pos := 20; pos < end; pos += int(h.recordSize) {
		rows = append(rows, b[pos:pos+int(h.recordSize)])
	}
	return h, rows, b[end:], nil
}
func u32(row []byte, field int) uint32  { return binary.LittleEndian.Uint32(row[field*4 : field*4+4]) }
func f32(row []byte, field int) float32 { return math.Float32frombits(u32(row, field)) }
func dbcString(block []byte, off uint32) string {
	if int(off) >= len(block) {
		return ""
	}
	b := block[off:]
	if i := strings.IndexByte(string(b), 0); i >= 0 {
		b = b[:i]
	}
	return string(b)
}

func queryRows(ctx context.Context, q interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}, query string, args ...any) ([]map[string]any, error) {
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols, _ := rows.Columns()
	out := make([]map[string]any, 0)
	for rows.Next() {
		raw := make([]any, len(cols))
		ptr := make([]any, len(cols))
		for i := range raw {
			ptr[i] = &raw[i]
		}
		if err := rows.Scan(ptr...); err != nil {
			return nil, err
		}
		m := map[string]any{}
		for i, c := range cols {
			if b, ok := raw[i].([]byte); ok {
				m[c] = string(b)
			} else {
				m[c] = raw[i]
			}
		}
		out = append(out, m)
	}
	return out, rows.Err()
}
func queryOne(ctx context.Context, db *sql.DB, q string, args ...any) (map[string]any, error) {
	rows, err := queryRows(ctx, db, q, args...)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, sql.ErrNoRows
	}
	return rows[0], nil
}
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func fail(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]any{"error": err.Error()})
}
func decode(r *http.Request, v any) error {
	d := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 2<<20))
	d.UseNumber()
	return d.Decode(v)
}
func pathUint(r *http.Request, key string) (uint64, error) {
	return strconv.ParseUint(r.PathValue(key), 10, 32)
}
func parseInt(s string, d int) int {
	v, e := strconv.Atoi(s)
	if e != nil {
		return d
	}
	return v
}
func clamp(v, min, max int) int {
	if v < min {
		return min
	}
	if v > max {
		return max
	}
	return v
}
func set(v []string) map[string]bool {
	m := map[string]bool{}
	for _, x := range v {
		m[x] = true
	}
	return m
}
func jsonValue(v any) any {
	if v == nil {
		return nil
	}
	if n, ok := v.(json.Number); ok {
		return n.String()
	}
	return v
}
func numeric(v any) (float64, bool) {
	if v == nil {
		return 0, false
	}
	n, err := strconv.ParseFloat(fmt.Sprint(v), 64)
	return n, err == nil
}
func toUint64(v any) uint64 { n, _ := strconv.ParseUint(fmt.Sprint(v), 10, 64); return n }
func defaultValue(v any, fallback any) any {
	if v == nil {
		return fallback
	}
	return jsonValue(v)
}
func nullString(v string) any {
	if strings.TrimSpace(v) == "" {
		return nil
	}
	return strings.TrimSpace(v)
}
func (a *api) requireWrite(w http.ResponseWriter) bool {
	if !a.writeEnabled {
		fail(w, 403, errors.New("database writes are disabled; set DB_WRITE_ENABLED=true"))
		return false
	}
	return true
}
func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS")
		if r.Method == "OPTIONS" {
			w.WriteHeader(204)
			return
		}
		next.ServeHTTP(w, r)
	})
}
func logging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("%s %s %s", r.Method, r.URL.Path, time.Since(start).Round(time.Millisecond))
	})
}

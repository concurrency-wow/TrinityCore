"use client";

import { useEffect, useState } from "react";
import ModelViewer from "./model-viewer";

type Row = Record<string, unknown>;
type Option = { value: number; label: string };
type Meta = { writeEnabled?: boolean; ranks?:Option[]; creatureTypes?:Option[]; classes?:Option[]; movementTypes?:Option[]; genders?:Option[]; gossipOptionTypes?:Option[]; smartEvents?:Option[]; smartActions?:Option[]; smartTargets?:Option[] };
type Doc = {
  template: Row; modelInfo: Row[]; spawns: Row[]; templateAddon: Row[]; movement: Row[];
  resistances: Row[]; spells: Row[]; equipment: Row[]; texts: Row[]; smart: Row[];
  smartConditions: Row[]; gossip: { menuId: number; pages: Row[]; options: Row[] };
};

const groups: Record<string, string[]> = {
  Identity: ["name","subname","IconName","minlevel","maxlevel","rank","type","family","faction","unit_class","exp","VerifiedBuild"],
  Appearance: ["modelid1","modelid2","modelid3","modelid4","scale","HoverHeight"],
  Interaction: ["gossip_menu_id","npcflag","RacialLeader","KillCredit1","KillCredit2"],
  Combat: ["dmgschool","BaseAttackTime","RangeAttackTime","BaseVariance","RangeVariance","HealthModifier","ManaModifier","ArmorModifier","DamageModifier","ExperienceModifier","RegenHealth","mechanic_immune_mask","spell_school_immune_mask"],
  Behavior: ["AIName","MovementType","speed_walk","speed_run","movementId","unit_flags","unit_flags2","dynamicflags","type_flags","flags_extra","ScriptName","StringId"],
  "Loot & Advanced": ["lootid","pickpocketloot","skinloot","mingold","maxgold","PetSpellDataId","VehicleId","difficulty_entry_1","difficulty_entry_2","difficulty_entry_3"],
};

const docs: Record<string,string> = {
  name:"Name displayed above the NPC and in tooltips.", subname:"Optional title displayed below the creature name.", IconName:"Client interaction cursor name, such as Directions or Buy. Usually blank.",
  minlevel:"Lowest level chosen when this creature spawns.", maxlevel:"Highest level chosen when this creature spawns; must not be below minlevel.", rank:"Normal, elite, rare, or boss classification; affects health and UI portrait treatment.", type:"Creature category from CreatureType.dbc, such as beast, humanoid, or undead.", family:"CreatureFamily.dbc ID, mainly used for tameable beasts and pet diets.",
  faction:"FactionTemplate.dbc ID. Invalid values prevent worldserver startup.", unit_class:"Creature power/stat class. TrinityCore accepts Warrior, Paladin, Rogue, or Mage.", exp:"Expansion stat set: 0 Classic, 1 The Burning Crusade, 2 Wrath.", npcflag:"Bitmask of interactions such as gossip, vendor, trainer, or quest giver.",
  modelid1:"CreatureDisplayInfo.dbc display ID, not a model-data ID.", modelid2:"Alternative randomly selected display ID.", modelid3:"Alternative randomly selected display ID.", modelid4:"Alternative randomly selected display ID.",
  scale:"Multiplier applied to the selected display model.", HoverHeight:"Hover offset relative to the model height; normally 1.",
  AIName:"Use SmartAI for smart_scripts. Difficulty templates inherit AI from their base template.", MovementType:"Template movement generator: idle, random, or waypoint.",
  movementId:"Optional creature_movement_info speed profile.", unit_flags:"UNIT_FIELD_FLAGS bitmask. Enter its decimal value.", unit_flags2:"UNIT_FIELD_FLAGS_2 bitmask. Enter its decimal value.",
  dynamicflags:"Dynamic unit-state bitmask. Template values include lootable, tapped, or dead presentation.", type_flags:"Creature type behavior bitmask.", flags_extra:"TrinityCore-only creature flags. Do not persist the runtime dungeon-boss bit.",
  gossip_menu_id:"Links this creature to gossip_menu.MenuID.", lootid:"creature_loot_template Entry.", pickpocketloot:"pickpocketing_loot_template Entry.", skinloot:"skinning_loot_template Entry.",
  RacialLeader:"Whether the client treats this NPC as a racial faction leader.", KillCredit1:"Creature entry awarded as kill credit when this creature dies.", KillCredit2:"Optional second creature entry awarded as kill credit.",
  dmgschool:"Melee damage school: 0 physical, then holy, fire, nature, frost, shadow, arcane.", BaseAttackTime:"Melee swing time in milliseconds. Zero is normalized to 2000 by the core.", RangeAttackTime:"Ranged swing time in milliseconds.", BaseVariance:"Melee damage variance multiplier; normally 1.", RangeVariance:"Ranged damage variance multiplier; normally 1.",
  HealthModifier:"Multiplier against creature_classlevelstats base health.", ManaModifier:"Multiplier against base mana.", ArmorModifier:"Multiplier against base armor.", DamageModifier:"Multiplier against base melee damage.", ExperienceModifier:"Multiplier for XP rewarded on kill.", RegenHealth:"1 enables normal out-of-combat health regeneration.", mechanic_immune_mask:"Bitmask of mechanics such as stun, fear, root, or silence to ignore.", spell_school_immune_mask:"Bitmask of spell schools to ignore.",
  speed_walk:"Ratio against the client base walk speed; normally 1.", speed_run:"Ratio against the client base run speed; normally 1.14286.", ScriptName:"Compiled C++ CreatureScript name. Leave blank when using SmartAI.", StringId:"Optional string identifier used by core scripts.",
  mingold:"Minimum copper dropped; must not exceed maxgold.", maxgold:"Maximum copper dropped.", PetSpellDataId:"CreatureSpellData.dbc record used by pet spell bars.", VehicleId:"Vehicle.dbc ID. Invalid IDs can freeze 3.3.5 clients.", difficulty_entry_1:"Heroic/alternate difficulty creature template entry.", difficulty_entry_2:"Second alternate difficulty template entry.", difficulty_entry_3:"Third alternate difficulty template entry.",
  VerifiedBuild:"Source client build/provenance. Custom records commonly use 0 or NULL.",
};

const columnDocs: Record<string,string> = {
  MenuID:"Gossip menu identifier. Multiple creatures may share it.", TextID:"npc_text.ID shown as this gossip page.", text0_0:"Primary gossip page text, usually the male/default variant.", text0_1:"Alternate gender gossip page text.", BroadcastTextID0:"Optional BroadcastText.dbc/world broadcast_text reference.",
  OptionID:"Option/action number within this menu. SmartAI gossip-select event_param2 matches this value.", OptionIcon:"Client gossip icon number.", OptionText:"Clickable text shown to the player.", OptionType:"Built-in gossip action type such as dialogue, vendor, trainer, or innkeeper.", OptionNpcFlag:"NPC flag required for this option to be available.", ActionMenuID:"Menu to open after selection; 0 closes or leaves handling to scripts.", ActionPoiID:"points_of_interest.ID shown after selection.", BoxCoded:"1 asks the player for a code/password.", BoxMoney:"Copper charged after confirmation.", BoxText:"Confirmation dialog text.", OptionBroadcastTextID:"Optional broadcast_text ID replacing OptionText.", BoxBroadcastTextID:"Optional broadcast_text ID replacing BoxText.",
  source_type:"SmartAI owner type. Creature template scripts use 0.", id:"Row ID within this SmartAI owner; links and conditions reference it.", link:"ID of a SMART_EVENT_LINK row executed after this action; 0 means none.", event_type:"Trigger that causes the row to run.", event_phase_mask:"Bitmask of allowed SmartAI phases; 0 means every phase.", event_chance:"Percent chance from 1 to 100. Zero prevents ordinary execution.", event_flags:"SmartAI event behavior/difficulty bitmask.", action_type:"Operation performed when the event fires.", target_type:"How SmartAI resolves the action target.", comment:"Human-readable explanation; essential for maintaining SmartAI rows.",
  event_param1:"Event-specific parameter 1. For Gossip Select this is MenuID; for timers it is initial minimum delay.", event_param2:"Event-specific parameter 2. For Gossip Select this is OptionID; for timers it is initial maximum delay.", event_param3:"Event-specific parameter 3, commonly repeat minimum delay.", event_param4:"Event-specific parameter 4, commonly repeat maximum delay.", event_param5:"Fifth event parameter used only by selected newer event definitions.",
  action_param1:"Action-specific parameter 1. For Talk this is creature_text GroupID; for Cast it is Spell ID.", action_param2:"Action-specific parameter 2; meaning depends on action type.", action_param3:"Action-specific parameter 3; meaning depends on action type.", action_param4:"Action-specific parameter 4; meaning depends on action type.", action_param5:"Action-specific parameter 5; meaning depends on action type.", action_param6:"Action-specific parameter 6; meaning depends on action type.",
  target_param1:"Target-specific parameter 1, often creature entry or GUID.", target_param2:"Target-specific parameter 2, often minimum distance.", target_param3:"Target-specific parameter 3, often maximum distance.", target_param4:"Target-specific parameter 4.", target_x:"Explicit target X coordinate for position-aware targets.", target_y:"Explicit target Y coordinate.", target_z:"Explicit target Z coordinate.", target_o:"Explicit target orientation in radians.",
  GroupID:"Speech group selected by SmartAI Talk actions.", ID:"Alternative row or equipment-set identifier within its parent.", Text:"Creature speech text.", Type:"Chat delivery type, such as say, yell, emote, whisper, or boss emote.", Language:"Language ID controlling who can understand the text.", Probability:"Relative chance of this alternative being selected.", Emote:"Emotes.dbc animation played with the text.", Duration:"Optional display duration in milliseconds.", Sound:"SoundEntries.dbc sound played with the text.", BroadcastTextId:"Optional broadcast_text.ID providing canonical/localized content.", TextRange:"Audience range: normal, area, zone, map, or world.",
  ItemID1:"Client item ID equipped in the main hand.", ItemID2:"Client item ID equipped in the off hand.", ItemID3:"Client item ID equipped in the ranged slot.", Index:"Zero-based creature spell slot; valid values are 0 through 7.", Spell:"Spell.dbc spell ID.", School:"Magic school 1 through 6; physical school 0 is invalid here.", Resistance:"Signed resistance amount for this magic school.", Ground:"Ground movement: none, run, or hover.", Swim:"Whether swimming movement is allowed.", Flight:"Flight mode: none, disable gravity, or can fly.", Rooted:"Whether the creature is unable to move.", Chase:"Chase movement walk/run policy.", Random:"Random movement walk/run policy.", InteractionPauseTimer:"Milliseconds movement pauses after player interaction.",
  guid:"Unique spawn identifier.", map:"Map.dbc map ID.", zoneId:"Cached zone identifier; normally calculated by the core.", position_x:"World X coordinate.", position_y:"World Y coordinate.", position_z:"World height coordinate.", orientation:"Facing in radians.", spawnMask:"Difficulty bitmask in which the spawn exists.", phaseMask:"Phase bitmask; zero is invalid and becomes 1.", spawntimesecs:"Respawn delay in seconds.", MovementType:"Spawn movement generator: idle, random, or waypoint.",
};

const tabNames = ["Template","Models","Gossip","SmartAI","Texts","Spawns","Advanced"];

function apiBase() {
  if (process.env.NEXT_PUBLIC_API_URL) return process.env.NEXT_PUBLIC_API_URL;
  if (typeof window !== "undefined") return `${window.location.protocol}//${window.location.hostname}:8080`;
  return "http://127.0.0.1:8080";
}

async function request(path: string, init?: RequestInit) {
  const response = await fetch(apiBase()+path, { ...init, headers: { "Content-Type":"application/json", ...init?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `${response.status} ${response.statusText}`);
  return body;
}

export default function CreatureWorkbench() {
  const [query,setQuery] = useState("");
  const [results,setResults] = useState<Row[]>([]);
  const [doc,setDoc] = useState<Doc|null>(null);
  const [draft,setDraft] = useState<Row>({});
  const [meta,setMeta] = useState<Meta>({});
  const [tab,setTab] = useState("Template");
  const [busy,setBusy] = useState(false);
  const [notice,setNotice] = useState("");
  const [error,setError] = useState("");
  const [createOpen,setCreateOpen] = useState(false);

  useEffect(() => { request("/api/meta").then(setMeta).catch(e=>setError(e.message)); },[]);
  useEffect(() => { const timer=setTimeout(()=>request(`/api/creatures?q=${encodeURIComponent(query)}`).then(x=>setResults(x.items)).catch(e=>setError(e.message)),180);return()=>clearTimeout(timer); },[query]);

  async function open(entry: unknown) {
    setBusy(true);setError("");
    try { const value=await request(`/api/creatures/${entry}`);setDoc(value);setDraft({...value.template});setTab("Template"); }
    catch(e){setError((e as Error).message)} finally{setBusy(false)}
  }
  async function reload(){if(doc) await open(doc.template.entry)}
  async function createCreature(values:Row){
    setBusy(true);setError("");try{await request("/api/creatures",{method:"POST",body:JSON.stringify(values)});const entry=String(values.entry);setCreateOpen(false);setQuery(entry);await open(entry);setNotice(`Creature #${entry} created`)}catch(e){setError((e as Error).message)}finally{setBusy(false)}
  }
  async function saveTemplate(){if(!doc)return;setBusy(true);setError("");try{await request(`/api/creatures/${doc.template.entry}`,{method:"PUT",body:JSON.stringify({template:draft})});setNotice("Creature template saved");await reload()}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
  function changed(key:string,value:unknown){setDraft(d=>({...d,[key]:value}))}

  return <main>
    <header className="topbar">
      <div className="brand-mark">TC</div>
      <div><div className="eyebrow">TRINITYCORE WORKSHOP</div><h1>Forgekeeper</h1></div>
      <div className="connection"><span className="status-dot"/>world@localhost <b>{meta.writeEnabled ? "WRITE" : "READ ONLY"}</b></div>
    </header>
    <div className="shell">
      <aside className="sidebar">
        <label className="search"><span>⌕</span><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Entry, name, or title" autoFocus /></label>
        <button className="new-creature" disabled={!meta.writeEnabled||busy} onClick={()=>setCreateOpen(true)}>+ NEW CREATURE</button>
        <div className="result-count">{results.length} CREATURES</div>
        <div className="results">
          {results.map(row=><button key={String(row.entry)} className={String(doc?.template.entry)===String(row.entry)?"result active":"result"} onClick={()=>open(row.entry)}>
            <span className="result-id">#{String(row.entry)}</span><strong>{String(row.name)}</strong><small>{row.subname ? String(row.subname) : `Level ${row.minlevel}–${row.maxlevel}`}</small><i>{String(row.spawn_count)} spawns</i>
          </button>)}
        </div>
      </aside>
      <section className="workspace">
        {(error||notice) && <div className={error?"toast error":"toast"} onClick={()=>{setError("");setNotice("")}}>{error||notice}<span>×</span></div>}
        {!doc ? <Empty busy={busy}/> : <>
          <div className="creature-head">
            <div><div className="eyebrow">CREATURE TEMPLATE <span>#{String(doc.template.entry)}</span></div><h2>{String(draft.name)}</h2><p>{draft.subname ? String(draft.subname) : "No title"} · Level {String(draft.minlevel)}–{String(draft.maxlevel)} · {doc.spawns.length} loaded spawns</p></div>
            <button className="save" disabled={busy||!meta.writeEnabled} onClick={saveTemplate}>{busy?"WORKING…":"SAVE TEMPLATE"}</button>
          </div>
          <nav className="tabs">{tabNames.map(name=><button key={name} className={tab===name?"active":""} onClick={()=>setTab(name)}>{name}{name==="SmartAI"&&<em>{doc.smart.length}</em>}{name==="Gossip"&&doc.gossip.menuId>0&&<em>{doc.gossip.options.length}</em>}</button>)}</nav>
          <div className="panel">
            {tab==="Template" && <TemplateForm draft={draft} changed={changed} meta={meta}/>} 
            {tab==="Models" && <Models draft={draft} modelInfo={doc.modelInfo}/>} 
            {tab==="Gossip" && <Gossip entry={Number(doc.template.entry)} data={doc.gossip} onSaved={reload}/>} 
            {tab==="SmartAI" && <SmartAI entry={Number(doc.template.entry)} rows={doc.smart} meta={meta} onSaved={reload} setAI={()=>changed("AIName","SmartAI")}/>} 
            {tab==="Texts" && <RelatedGrid title="Creature Speech" hint="SmartAI Talk actions reference GroupID. Rows in one group are randomized alternatives." entry={Number(doc.template.entry)} resource="texts" rows={doc.texts} columns={["GroupID","ID","Text","Type","Language","Probability","Emote","Duration","Sound","BroadcastTextId","TextRange","comment"]} onSaved={reload}/>} 
            {tab==="Spawns" && <SpawnTable rows={doc.spawns}/>} 
            {tab==="Advanced" && <Advanced doc={doc} entry={Number(doc.template.entry)} onSaved={reload}/>} 
          </div>
        </>}
      </section>
    </div>
    {createOpen&&<CreateCreatureDialog currentEntry={Number(doc?.template.entry)||295} meta={meta} busy={busy} onClose={()=>setCreateOpen(false)} onCreate={createCreature}/>} 
  </main>
}

function CreateCreatureDialog({currentEntry,meta,busy,onClose,onCreate}:{currentEntry:number;meta:Meta;busy:boolean;onClose:()=>void;onCreate:(values:Row)=>void}){
  const [mode,setMode]=useState<"blank"|"clone">("blank");
  const [form,setForm]=useState<Row>({entry:"",name:"Custom Creature",subname:"",cloneFrom:currentEntry,displayId:782,faction:35,minLevel:1,maxLevel:1,rank:0,type:7,unitClass:1});
  function set(key:string,value:unknown){setForm(v=>({...v,[key]:value}))}
  const options:Record<string,Option[]|undefined>={rank:meta.ranks,type:meta.creatureTypes,unitClass:meta.classes};
  const fields=mode==="clone"?["entry","name","cloneFrom"]:["entry","name","subname","displayId","faction","minLevel","maxLevel","rank","type","unitClass"];
  const labels:Record<string,string>={entry:"New entry",cloneFrom:"Clone template entry",displayId:"Display ID",minLevel:"Minimum level",maxLevel:"Maximum level",unitClass:"Unit class"};
  const help:Record<string,string>={entry:"Unused creature_template.entry for the new NPC.",cloneFrom:"Copies safe combat, appearance, and behavior defaults, then clears shared gossip, loot, and C++ script references.",displayId:"Required CreatureDisplayInfo.dbc ID. Display 782 is a non-humanoid wolf suitable for a blank starting point.",faction:docs.faction,minLevel:docs.minlevel,maxLevel:docs.maxlevel,unitClass:docs.unit_class};
  return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose()}}><section className="modal"><div className="modal-head"><div><div className="eyebrow">CREATURE TEMPLATE</div><h3>Create New NPC</h3></div><button onClick={onClose}>×</button></div><div className="mode-switch"><button className={mode==="blank"?"active":""} onClick={()=>setMode("blank")}>Blank NPC</button><button className={mode==="clone"?"active":""} onClick={()=>setMode("clone")}>Clone Existing</button></div><p className="modal-copy">{mode==="blank"?"Start from TrinityCore-safe defaults. Required DBC references are validated before insertion.":"Copy one valid template as a starting point without copying shared gossip, loot, or scripts."}</p><div className="modal-fields">{fields.map(key=><label className="field" key={key}><span>{labels[key]||key}<i title={help[key]||docs[key]||"Value stored in creature_template"}>?</i></span>{options[key]?<select value={String(form[key])} onChange={e=>set(key,Number(e.target.value))}>{options[key]?.map(o=><option value={o.value} key={o.value}>{o.value} · {o.label}</option>)}</select>:<input value={String(form[key]??"")} onChange={e=>set(key,["name","subname"].includes(key)?e.target.value:numberOrText(e.target.value))}/>}</label>)}</div><div className="modal-actions"><button onClick={onClose}>CANCEL</button><button className="save" disabled={busy} onClick={()=>onCreate({...form,cloneFrom:mode==="clone"?Number(form.cloneFrom):0})}>{busy?"CREATING…":"CREATE NPC"}</button></div></section></div>
}

function Empty({busy}:{busy:boolean}){return <div className="empty"><div className="rune">✦</div><div className="eyebrow">CREATURE MODULE</div><h2>{busy?"Loading creature…":"Select a creature to begin"}</h2><p>Search the live world database by entry, name, or title. Changes are written directly to the configured database.</p></div>}

function TemplateForm({draft,changed,meta}:{draft:Row;changed:(k:string,v:unknown)=>void;meta:Meta}){
  const selects:Record<string,Option[]|undefined>={rank:meta.ranks,type:meta.creatureTypes,unit_class:meta.classes,MovementType:meta.movementTypes};
  return <div className="form-groups">{Object.entries(groups).map(([name,fields])=><section className="form-section" key={name}><h3>{name}</h3><div className="field-grid">{fields.map(key=><Field key={key} name={key} value={draft[key]} options={selects[key]} onChange={v=>changed(key,v)}/>)}</div></section>)}</div>
}

function Field({name,value,onChange,options}:{name:string;value:unknown;onChange:(v:unknown)=>void;options?:Option[]}){
  const text=String(value??"");
  return <label className={name==="name"||name==="subname"||name==="ScriptName"||name==="StringId"?"field wide":"field"}><span>{name}<i title={docs[name]||"TrinityCore world database field"}>?</i></span>
    {options?<select value={text} onChange={e=>onChange(Number(e.target.value))}>{options.map(o=><option key={o.value} value={o.value}>{o.value} · {o.label}</option>)}</select>:<input value={text} onChange={e=>onChange(isNumericValue(value)?numberOrText(e.target.value):e.target.value)} />}
    {docs[name]&&<small>{docs[name]}</small>}
  </label>
}
function isNumericValue(v:unknown){return typeof v==="number"||(/^[-+]?\d+(\.\d+)?$/.test(String(v??""))&&String(v??"")!=="")}
function numberOrText(v:string){if(v===""||v==="-"||v.endsWith("."))return v;const n=Number(v);return Number.isNaN(n)?v:n}

function Models({draft,modelInfo}:{draft:Row;modelInfo:Row[]}){
  const ids=[1,2,3,4].map(i=>Number(draft[`modelid${i}`])).filter(Boolean);
  return <div><div className="section-title"><div><h3>Display Variants</h3><p>Resolved from local 3.3.5a DBC records. A GLB is rendered only when it exists in the local conversion cache.</p></div></div><div className="model-grid">{ids.map((id,i)=><ModelCard key={`${id}-${i}`} id={id} db={modelInfo.find(x=>Number(x.DisplayID)===id)}/>)}</div>{!ids.length&&<div className="callout warn">This template has no display IDs. TrinityCore may reject it and invalid displays can crash 3.3.5 clients.</div>}</div>
}
function ModelCard({id,db}:{id:number;db?:Row}){
  const [data,setData]=useState<Row|null>(null);const [error,setError]=useState("");
  function refresh(){setError("");request(`/api/displays/${id}`).then(setData).catch(e=>setError(e.message))}
  useEffect(refresh,[id]);
  const display=data?.display as Row|undefined;const model=data?.model as Row|undefined;const url=data?.renderUrl ? apiBase()+String(data.renderUrl):"";const composite=data?.renderClass==="composite-humanoid";
  return <article className="model-card"><div className="viewer">{url?<ModelViewer url={url}/>:<div className="model-missing"><b>{error?"DBC ?":"GLB"}</b><span>{error||(composite?"Baked humanoid conversion required":"Asset conversion required")}</span>{!error&&<code>./convert-model {id}</code>}<button onClick={refresh}>CHECK CACHE</button></div>}<span className="display-chip">DISPLAY {id}</span></div><div className="model-details"><strong>{model?.path?String(model.path):"Resolving model…"}</strong><dl><dt title="CreatureModelData.dbc model record">Model ID</dt><dd>{String(display?.modelId??"—")}</dd><dt title="CreatureDisplayInfo.dbc model scale">DBC scale</dt><dd>{String(display?.scale??"—")}</dd><dt title="Melee contact distance from creature_model_info">Combat reach</dt><dd>{String(db?.CombatReach??"—")}</dd><dt title="Whether a converted GLB exists in model-cache">Pipeline</dt><dd className="amber">{String(data?.renderStatus??"checking")}</dd></dl>{Array.isArray(display?.textures)&&<p>{(display.textures as string[]).join(" · ")||"Baked humanoid textures"}</p>}</div></article>
}

function Gossip({entry,data,onSaved}:{entry:number;data:Doc["gossip"];onSaved:()=>void}){
  const [menu,setMenu]=useState(data.menuId||entry);const [pages,setPages]=useState<Row[]>(data.pages.map(x=>({...x})));const [options,setOptions]=useState<Row[]>(data.options.map(x=>({...x})));const [status,setStatus]=useState("");
  useEffect(()=>{setMenu(data.menuId||entry);setPages(data.pages.map(x=>({...x})));setOptions(data.options.map(x=>({...x})))},[data,entry]);
  async function save(){try{await request(`/api/gossip/${menu}`,{method:"PUT",body:JSON.stringify({entry,pages,options})});setStatus("Gossip saved");onSaved()}catch(e){setStatus((e as Error).message)}}
  return <div><div className="section-title"><div><h3>Gossip Builder</h3><p>Menu text comes from npc_text. Options can open another menu or fire SmartAI event 62.</p></div><button className="save mini" onClick={save}>SAVE GOSSIP</button></div>{status&&<div className="inline-status">{status}</div>}<div className="callout"><b>Menu ownership</b> Menu IDs can be shared by several creatures. Editing menu {menu} changes every user of that menu.</div><label className="field menu-id"><span>MenuID <i title={columnDocs.MenuID}>?</i></span><input value={menu} onChange={e=>setMenu(Number(e.target.value))}/></label>
    <EditableTable title="Pages / NPC Text" rows={pages} setRows={setPages} columns={["TextID","text0_0","text0_1","BroadcastTextID0","VerifiedBuild"]} defaults={{TextID:menu,text0_0:"Greetings, traveler.",text0_1:"",BroadcastTextID0:0,VerifiedBuild:0}}/>
    <EditableTable title="Options" rows={options} setRows={setOptions} columns={["OptionID","OptionIcon","OptionText","OptionType","OptionNpcFlag","ActionMenuID","ActionPoiID","BoxCoded","BoxMoney","BoxText","OptionBroadcastTextID","BoxBroadcastTextID","VerifiedBuild"]} defaults={{OptionID:options.length,OptionIcon:0,OptionText:"Tell me more.",OptionType:1,OptionNpcFlag:1,ActionMenuID:0,ActionPoiID:0,BoxCoded:0,BoxMoney:0,BoxText:"",OptionBroadcastTextID:0,BoxBroadcastTextID:0,VerifiedBuild:0}}/>
  </div>
}

function SmartAI({entry,rows,meta,onSaved,setAI}:{entry:number;rows:Row[];meta:Meta;onSaved:()=>void;setAI:()=>void}){
  const columns=["source_type","id","link","event_type","event_phase_mask","event_chance","event_flags","event_param1","event_param2","event_param3","event_param4","event_param5","action_type","action_param1","action_param2","action_param3","action_param4","action_param5","action_param6","target_type","target_param1","target_param2","target_param3","target_param4","target_x","target_y","target_z","target_o","comment"];
  const [draft,setDraft]=useState(rows.map(x=>({...x})));useEffect(()=>setDraft(rows.map(x=>({...x}))),[rows]);
  const selects={event_type:meta.smartEvents,action_type:meta.smartActions,target_type:meta.smartTargets};
  async function save(){setAI();await request(`/api/creatures/${entry}/related/smart`,{method:"PUT",body:JSON.stringify({rows:draft})});onSaved()}
  function preset(event:number){setAI();setDraft(d=>[...d,{source_type:0,id:nextId(d),link:0,event_type:event,event_phase_mask:0,event_chance:100,event_flags:0,event_param1:0,event_param2:0,event_param3:0,event_param4:0,event_param5:0,action_type:1,action_param1:0,action_param2:0,action_param3:0,action_param4:0,action_param5:0,action_param6:0,target_type:7,target_param1:0,target_param2:0,target_param3:0,target_param4:0,target_x:0,target_y:0,target_z:0,target_o:0,comment:event===64?`${entry} - On gossip hello - Talk`:`${entry} - On gossip select - Talk`}])}
  return <div><div className="section-title"><div><h3>SmartAI Script</h3><p>Template scripts require <code>AIName = SmartAI</code>. Parameters remain lossless and map directly to smart_scripts.</p></div><button className="save mini" onClick={save}>SAVE SCRIPT</button></div><div className="preset-row"><button onClick={()=>preset(64)}>+ Gossip Hello</button><button onClick={()=>preset(62)}>+ Gossip Select</button><button onClick={()=>setDraft(d=>[...d,blankSmart(nextId(d))])}>+ Blank Event</button></div><EditableTable title={`${draft.length} Events`} rows={draft} setRows={setDraft} columns={columns} defaults={blankSmart(nextId(draft))} selects={selects}/></div>
}
function nextId(rows:Row[]){return rows.reduce((m,r)=>Math.max(m,Number(r.id)||0),-1)+1}
function blankSmart(id:number):Row{return {source_type:0,id,link:0,event_type:0,event_phase_mask:0,event_chance:100,event_flags:0,event_param1:1000,event_param2:1000,event_param3:5000,event_param4:5000,event_param5:0,action_type:1,action_param1:0,action_param2:0,action_param3:0,action_param4:0,action_param5:0,action_param6:0,target_type:1,target_param1:0,target_param2:0,target_param3:0,target_param4:0,target_x:0,target_y:0,target_z:0,target_o:0,comment:"New SmartAI event"}}

function RelatedGrid({title,hint,entry,resource,rows,columns,onSaved}:{title:string;hint:string;entry:number;resource:string;rows:Row[];columns:string[];onSaved:()=>void}){
  const [draft,setDraft]=useState(rows.map(x=>({...x})));const [status,setStatus]=useState("");useEffect(()=>setDraft(rows.map(x=>({...x}))),[rows]);
  async function save(){try{await request(`/api/creatures/${entry}/related/${resource}`,{method:"PUT",body:JSON.stringify({rows:draft})});setStatus("Saved");onSaved()}catch(e){setStatus((e as Error).message)}}
  return <div><div className="section-title"><div><h3>{title}</h3><p>{hint}</p></div><button className="save mini" onClick={save}>SAVE {title.toUpperCase()}</button></div>{status&&<div className="inline-status">{status}</div>}<EditableTable title={`${draft.length} Rows`} rows={draft} setRows={setDraft} columns={columns} defaults={Object.fromEntries(columns.map(c=>[c,c.toLowerCase().includes("text")||c==="comment"?"":0]))}/></div>
}

function EditableTable({title,rows,setRows,columns,defaults,selects={}}:{title:string;rows:Row[];setRows:(v:Row[])=>void;columns:string[];defaults:Row;selects?:Record<string,Option[]|undefined>}){
  function edit(i:number,c:string,v:unknown){setRows(rows.map((r,n)=>n===i?{...r,[c]:v}:r))}
  return <section className="table-block"><div className="table-title"><h4>{title}</h4><button onClick={()=>setRows([...rows,{...defaults}])}>+ ADD ROW</button></div><div className="table-scroll"><table><thead><tr>{columns.map(c=><ColumnHeader key={c} name={c}/>)}<th/></tr></thead><tbody>{rows.map((row,i)=><tr key={i}>{columns.map(c=><td key={c}>{selects[c]?<select value={String(row[c]??0)} onChange={e=>edit(i,c,Number(e.target.value))}>{selects[c]?.map(o=><option key={o.value} value={o.value}>{o.value} · {o.label}</option>)}</select>:<input title={columnDocs[c]||docs[c]||c} className={c.toLowerCase().includes("text")||c==="comment"?"cell-text":""} value={String(row[c]??"")} onChange={e=>edit(i,c,isNumericValue(row[c])?numberOrText(e.target.value):e.target.value)}/>}</td>)}<td><button className="delete" title="Delete this row when the section is saved" onClick={()=>setRows(rows.filter((_,n)=>n!==i))}>×</button></td></tr>)}</tbody></table></div></section>
}

function ColumnHeader({name}:{name:string}){const help=columnDocs[name]||docs[name]||"TrinityCore database column";return <th title={help}><span className="column-label">{name}<i>?</i></span></th>}

function SpawnTable({rows}:{rows:Row[]}){return <div><div className="section-title"><div><h3>World Spawns</h3><p>Showing up to 500 placements. Spawn editing is intentionally read-only in this first module to avoid invalid map coordinates.</p></div><span className="count-chip">{rows.length} SPAWNS</span></div><div className="table-scroll"><table><thead><tr>{["guid","map","zoneId","position_x","position_y","position_z","orientation","spawnMask","phaseMask","spawntimesecs","MovementType"].map(x=><ColumnHeader name={x} key={x}/>)}</tr></thead><tbody>{rows.map(r=><tr key={String(r.guid)}>{["guid","map","zoneId","position_x","position_y","position_z","orientation","spawnMask","phaseMask","spawntimesecs","MovementType"].map(x=><td title={columnDocs[x]} key={x}>{String(r[x]??"")}</td>)}</tr>)}</tbody></table></div></div>}

function Advanced({doc,entry,onSaved}:{doc:Doc;entry:number;onSaved:()=>void}){return <div className="advanced-grid"><RelatedGrid title="Equipment Sets" hint="ItemID1, ItemID2, and ItemID3 are client item IDs for main hand, off hand, and ranged slots." entry={entry} resource="equipment" rows={doc.equipment} columns={["ID","ItemID1","ItemID2","ItemID3","VerifiedBuild"]} onSaved={onSaved}/><RelatedGrid title="Spells" hint="Eight zero-based spell slots are supported." entry={entry} resource="spells" rows={doc.spells} columns={["Index","Spell","VerifiedBuild"]} onSaved={onSaved}/><RelatedGrid title="Resistances" hint="Schools 1 through 6 are magic schools; physical school 0 is not valid here." entry={entry} resource="resistances" rows={doc.resistances} columns={["School","Resistance","VerifiedBuild"]} onSaved={onSaved}/><RelatedGrid title="Movement Capabilities" hint="A single optional template movement row. Empty values inherit core defaults." entry={entry} resource="movement" rows={doc.movement} columns={["Ground","Swim","Flight","Rooted","Chase","Random","InteractionPauseTimer"]} onSaved={onSaved}/></div>}

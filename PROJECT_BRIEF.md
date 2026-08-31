# PROJECT_BRIEF.md — Agent Studio

**เวอร์ชัน 4** — ถอย gamification ออก (ดู §1 และ §15 แถว 28) รวมผลรีวิวรอบสองไว้ครบ:
provider DeepSeek-first, request building ขับด้วย capabilities, usage แยก cache read/write,
token handshake ใช้ stdin
เอกสารนี้คือ single source of truth อ่านให้จบก่อนทำอะไรทุกครั้ง
ถ้าเจอจุดที่ขัดกันเองในเอกสารนี้ ให้หยุดแล้วถาม อย่าเดา

---

## 1. เราจะสร้างอะไร

Desktop app สำหรับสร้างและรันระบบ multi-agent โดยมี **ธีมและ UX แบบเกม RPG**
ผู้ใช้สร้าง agent เหมือนสร้างตัวละคร จัดเป็นทีม บันทึกไว้ใช้ซ้ำได้หลายทีม
แล้วส่งทีมออกไปทำภารกิจ ระหว่างนั้นจะเห็นตัวละครแบบ 2.5D กำลังทำงานอยู่ในฉาก
พร้อม timeline log ที่อ่านได้จริง และผู้ใช้แทรกเข้าไปตอบคำถามหรืออนุมัติงานได้ระหว่างทาง

**สิ่งที่ทำให้แอปนี้ต่างจาก agent framework ทั่วไป: ความ observable**
ทุกอย่างที่ AI ทำต้องมองเห็นได้ ไม่ใช่กล่องดำ ฉากเกมคือ UI ของ observability ไม่ใช่ของตกแต่ง

**บททดสอบของทุกการตัดสินใจ:** ถ้าฟีเจอร์นี้ทำให้ timeline โกหกผู้ใช้ หรือทำให้ replay
แสดงผลไม่ตรงกับที่เกิดขึ้นจริง แสดงว่าออกแบบผิด

### 1.1 ธีมเกมอยู่ที่รูปลักษณ์ ไม่ใช่ระบบตัวเลข

**เกณฑ์ตัดสินสำหรับงาน UI ทุกชิ้นต่อจากนี้:
ทุกอย่างที่แสดงต้องเป็นความจริงเกี่ยวกับ agent ตัวนั้น ไม่ใช่คะแนนที่เราแต่งขึ้นมา**

| แสดงได้ (เป็นความจริง) | ห้ามแสดง (เราแต่งขึ้น) |
|---|---|
| `12 missions` — นับจาก mission ที่จบจริง | level, exp, แถบความคืบหน้าไปเลเวลถัดไป |
| `1,240 tokens · $0.004` — ค่าใช้จ่ายจริง | แถบพลัง / MP / stamina |
| model, role, tools ที่ถืออยู่จริง | class, rarity, ค่าพลังโจมตี |
| สถานะจาก event stream | HP bar, damage number |

ธีมเกม **อยู่ตรงนี้:** portrait ใหญ่, การ์ดตัวละคร, การเลือกหน้าตา, การพิมพ์ backstory,
ธีมสีเข้ม, และฉาก 2.5D ตอนทำงาน (M5) ที่ตัวละครสะท้อนสถานะจริงจาก event stream

ตัวเลขที่แต่งขึ้นมาทำให้ UI โกหก ซึ่งเป็นความล้มเหลวแบบเดียวกับที่ §1 ห้ามไว้อยู่แล้ว

---

## 2. ข้อจำกัดที่ห้ามละเมิด

1. **Event-driven เป็นแกนกลาง** — ทุกการกระทำของ agent ต้องยิงออกมาเป็น event
   ฉากเกม, timeline, และ state ทั้งหมดของ frontend เป็นแค่ผู้บริโภค event stream
   ห้าม frontend เรียก LLM ตรง ๆ หรือรู้เรื่อง orchestration
2. **Event schema คือสัญญากลาง** — นิยามครั้งเดียวที่ `packages/shared/events.schema.json`
   แล้ว generate ทั้ง TypeScript type และ Pydantic model จากไฟล์นั้น ห้ามเขียนมือสองที่
   นี่คือสัญญาเดียวที่ต้อง sync — อย่างอื่น (tool list, model list) backend เสิร์ฟผ่าน REST
3. **Event bus เป็น single writer** — bus เท่านั้นที่แจก `seq` และ `ts`, persist ก่อน broadcast เสมอ
   ห้ามผู้ผลิต event แจกเลขเองหรือประทับเวลาเอง
4. **Local-first + ต้องมี auth** — ข้อมูลอยู่บนเครื่องผู้ใช้ ไม่มี cloud backend
   แต่ backend เป็น HTTP server ที่ถือกุญแจ keychain อยู่ จึงต้อง bind loopback
   และมี per-launch token เสมอ (ดู §9)
5. **API key อยู่ในฝั่ง Python เท่านั้น** ผ่าน `keyring` — Tauri ไม่เคยเห็น key
   ห้ามอยู่ใน localStorage, env var, argv, SQLite, หรือไฟล์ export
6. **Budget guard ต้องมีตั้งแต่วันแรก** และผู้ใช้ต้องกดหยุดได้ตั้งแต่ M1
7. **Code execution ต้องอยู่ใน sandbox** — จำกัด working directory, ไม่มี network โดย default
8. **Forward compatibility** — ตาราง event เป็น append-only ตลอดกาล frontend ต้อง degrade
   ไม่ crash เมื่อเจอค่าที่ไม่รู้จัก ทุกที่ (ดู §8)
9. **ห้ามแตะเลเยอร์กราฟิกก่อน M5**

---

## 3. Stack (ตัดสินใจแล้ว ไม่ต้องเสนอทางเลือกใหม่)

| ชั้น | เลือกใช้ |
|---|---|
| Desktop shell | Tauri v2 (ถ้าติดปัญหาหนักให้ fallback เป็น Electron แล้วบอกเหตุผล) |
| Frontend | React 18 + TypeScript + Vite + Tailwind v4 + shadcn/ui |
| State | Zustand |
| Validation | zod (frontend), Pydantic (backend) |
| Game layer | PixiJS v8 แบบ isometric 2.5D — **ไม่ใช่ 3D** |
| Backend | Python 3.13 (pin) / FastAPI |
| Orchestration | LangGraph — **เข้า M4 เท่านั้น** (ดู §4.1) |
| DB | SQLite + Alembic + sqlite-vec |
| Transport | WebSocket สำหรับ event, REST สำหรับ CRUD และ command |
| Codegen | json-schema-to-typescript + datamodel-code-generator |
| Packaging | PyInstaller → Tauri sidecar (M7) |
| Dependency | uv (Python), npm workspaces (JS) |

### 3.1 Provider

รองรับหลายเจ้าผ่าน `LLMProvider` protocol เดียว agent runtime **ห้าม import provider
ตัวใดตัวหนึ่งตรง ๆ** ต้องผ่าน registry เสมอ

**ลำดับการทำ:**
- `OpenAICompatibleProvider` — ทำก่อน รับ `base_url` ครอบคลุม DeepSeek, OpenAI, Ollama,
  LM Studio, vLLM, OpenRouter, LiteLLM, Groq, Together
- `AnthropicProvider` — ทำใน M1 ด้วย แต่ยังไม่ต้อง test เต็ม interface ต้องพร้อมสลับ

**Dev default: DeepSeek** — เหตุผลคือราคา

หมายเหตุตามตรง: ที่ M1 ค่าใช้จ่ายต่างกันหลักเศษสตางค์ (ส่งข้อความสั้นไม่กี่สิบครั้ง)
ราคาเริ่มมีผลจริงที่ M4 ตอน mission วน loop **แต่ผลของการเลือก provider ไปโผล่ที่ M2**
ซึ่งทั้ง milestone ตั้งอยู่บน structured output → ดูหัวข้อ "structured output" ข้างล่าง
ที่ออกแบบให้กันตัวเองไว้แล้ว

#### สอง provider ใช้คนละ SDK ห้ามปน

- `OpenAICompatibleProvider` → `openai` SDK ชี้ `base_url` ไปปลายทาง
- `AnthropicProvider` → `anthropic` SDK เท่านั้น
  **ห้ามยิง Anthropic ผ่าน OpenAI-compatible shim** ทรง request/response คนละอย่าง
  จะได้ผลเพี้ยนแบบเงียบ ๆ (thinking block, tool_use block, usage หายไปหมด)

นี่คือเหตุผลที่ต้องมี protocol กลาง — ข้างในมันคนละโลกจริง ๆ ไม่ใช่แค่ base_url ต่างกัน

#### Model — อ่านจาก config เท่านั้น ห้าม hardcode

| ใช้ทำอะไร | model |
|---|---|
| dev / งานทั่วไป | `deepseek-v4-flash` |
| งานหนัก | `deepseek-v4-pro` |
| Anthropic ตอนเทียบผล (M4) | `claude-haiku-4-5` (dev), `claude-sonnet-5` (จริง) |

⚠️ **id พวกนี้ยืนยันไม่ได้ทั้งหมด** — `deepseek-v4-flash` / `deepseek-v4-pro` และเรื่อง
การปลดระวาง `deepseek-chat` / `deepseek-reasoner` เมื่อ 24 ก.ค. 2026 อยู่นอกข้อมูลที่ตรวจสอบได้
เช่นเดียวกับ Haiku 4.5 ที่มี id ลอยอยู่สองแบบ (`claude-haiku-4-5` กับ `claude-haiku-4-5-20251001`)

→ **แก้ด้วยการไม่เดา:** ปุ่ม test connection ยิง `GET /v1/models` ของ base_url นั้นก่อนเสมอ
แล้วเทียบว่า id ใน config มีจริงไหม ถ้าไม่มี แสดงรายการที่มีจริงให้ผู้ใช้เลือก
**ห้ามมี model id ตัวไหน hardcode อยู่ในโค้ด**

#### Protocol

```python
class LLMProvider(Protocol):
    async def stream(self, req: ChatRequest) -> AsyncIterator[Chunk]: ...
    async def probe(self, model: str) -> Capabilities: ...
    async def list_models(self) -> list[str]: ...
```

`stream()` รับ object เดียว **ไม่รับ `temperature` เป็น argument แยก** (ดูหัวข้อถัดไป)

#### ⚠️ request ของแต่ละ model ไม่ได้ทรงเดียวกัน แม้แต่ใน provider เดียวกัน

ตัวอย่างที่เจอแน่ ๆ ตอนสลับไป Anthropic ที่ M4:
`temperature` / `top_p` / `top_k` **ถูกถอดออกจาก Claude Sonnet 5 แล้ว — ส่งไปจะได้ 400**
ขณะที่ Haiku 4.5 และ DeepSeek ยังรับได้ปกติ

ผลที่ตามมา:
- `agents.temperature` ที่เป็น column ตรง ๆ **ใช้ไม่ได้** → เปลี่ยนเป็น `sampling (json, nullable)`
- ประกอบ request ต้อง **ขับด้วย `capabilities`** ไม่ใช่ if-else ตามชื่อ provider
- ถ้า model ไม่รับ sampling แต่ agent ตั้งค่าไว้ → provider **ตัดทิ้ง ไม่ใช่ส่งไปให้ error**
  แล้วยิง `error` event `recoverable: true` ให้ timeline เห็น
  (ห้ามเงียบ — §1 บอกว่า timeline ต้องไม่โกหก)

เรื่องเดียวกันยังมีอีกสองจุด: **extended thinking** (Sonnet 5 ใช้ adaptive,
Haiku 4.5 ใช้ budget แบบเก่า) และ **effort** (Sonnet 5 มี, Haiku 4.5 ส่งไปจะ error)

#### ⚠️ structured output ของ OpenAI-compatible ไม่ได้แข็งเท่ากัน

"OpenAI-compatible" มีสองระดับที่ต่างกันมาก:

| ระดับ | ทรง | บังคับ schema |
|---|---|---|
| JSON mode | `response_format: {type: "json_object"}` | **ไม่** |
| Schema mode | `response_format: {type: "json_schema", strict: true, ...}` | ใช่ |

ปลายทางหลายเจ้ารองรับแค่ระดับแรก **ห้ามสมมติว่ารองรับระดับที่สอง** ต้อง probe จริง

**กติกาที่กันตัวเองไว้:** `agents/profile_gen.py` (M2) ต้อง validate ด้วย Pydantic
แล้ว retry เสมอ **ไม่ว่า provider จะบอกว่ารองรับ schema mode หรือไม่**
เพราะ M2 ทั้ง milestone ตั้งอยู่บน structured output ถ้าพึ่ง strict mode อย่างเดียว
แล้วปลายทางไม่มีให้ M2 จะพังแบบไล่สาเหตุยาก

#### Capabilities

```python
@dataclass
class Capabilities:
    tool_calling: bool
    structured_output: "schema" | "json_object" | "none"
    vision: bool
    sampling_params: bool          # temperature/top_p/top_k ส่งได้ไหม
    thinking: "adaptive" | "budget" | "none"
    effort: bool
    max_input_tokens: int          # ไม่ใช้ชื่อ context_window — Models API ใช้ชื่อนี้
    max_output_tokens: int
```

**Provider profile** เก็บใน SQLite ไม่ hardcode:
`id, kind (openai_compatible | anthropic), base_url, model, capabilities (json), verified_at`

#### ปุ่ม test connection — ยิงจริง 4 อย่าง

เพราะ "รองรับ tool calling" ในสเปกของ provider ไม่เท่ากับใช้ได้จริง:

1. **`GET /v1/models`** — model id นี้มีจริงที่ปลายทางนั้นไหม
2. **chat + stream** — key ถูกไหม ต่อเน็ตได้ไหม stream ทำงานไหม
3. **tool call** — ส่ง tool หนึ่งตัว ดูว่าได้ tool call กลับมาถูกทรงไหม
4. **structured output** — ลอง schema mode ก่อน ถ้าไม่ผ่านค่อยลอง json_object
   แล้วบันทึกว่าได้ระดับไหน

ผลลง `capabilities` + `verified_at` → หน้า agent creator เตือนได้ว่า
"model นี้ทำ tool call ไม่ผ่าน" หรือ "model นี้บังคับ schema ไม่ได้ ต้อง retry เอา"
**แสดงผลทีละข้อ ไม่ใช่ ✓/✗ ก้อนเดียว**

### 3.2 First-run onboarding

- เปิดแอปครั้งแรก ถ้ายังไม่มี key ใน keychain → บังคับเข้าหน้า onboarding ใช้อย่างอื่นไม่ได้
- key เข้า OS keychain เท่านั้น (ดู §9.2)
- ปุ่ม test connection ตาม §3.1
- repo ต้องมี `.env.example` และ **ห้ามมี `.env` ที่มี key จริง** (มี test บังคับ)
- ปิดแอปเปิดใหม่ key ต้องยังอยู่ ไม่ต้องใส่ซ้ำ

---

## 4. โครงสร้าง repo

```
agent-studio/
├─ PROJECT_BRIEF.md
├─ CLAUDE.md                  # working notes สำหรับ session ถัดไป
├─ packages/shared/
│  ├─ events.schema.json      # สัญญากลาง (envelope + payload union)
│  └─ codegen/                # generate TS type + Pydantic model
├─ apps/desktop/
│  └─ src/
│     ├─ features/
│     │  ├─ settings/         # ใส่ API key, จัดการ provider profile  [M1]
│     │  ├─ chat/             # คุยกับ agent + ปุ่มหยุด               [M1]
│     │  ├─ agent-creator/    #                                      [M2]
│     │  ├─ roster/           #                                      [M2]
│     │  ├─ teams/            # team builder + team library           [M3]
│     │  ├─ mission/          #                                      [M4]
│     │  ├─ timeline/         #                                      [M4]
│     │  └─ approval/         #                                      [M6]
│     ├─ scene/               #                                      [M5]
│     │  ├─ engine/           # PixiJS setup, camera, isometric tilemap
│     │  ├─ entities/
│     │  ├─ animation/        # state machine ของท่าทาง + default pose
│     │  └─ bindings/         # event -> animation mapper
│     ├─ stores/
│     ├─ transport/           # ws client, resume logic, dedupe
│     └─ components/ui/
├─ services/agentd/
│  ├─ main.py
│  ├─ core/
│  │  ├─ events.py            # event bus: single writer, seq, ts, redaction
│  │  ├─ budget.py
│  │  ├─ auth.py              # per-launch token
│  │  └─ secrets.py           # keyring adapter
│  ├─ providers/
│  ├─ agents/
│  │  ├─ profile_gen.py
│  │  ├─ registry.py
│  │  └─ runtime.py           # async generator ที่ yield event
│  ├─ teams/
│  │  ├─ service.py
│  │  └─ validator.py         # คืน severity: warn | error
│  ├─ orchestrator/           #                                      [M4]
│  ├─ tools/
│  ├─ memory/
│  └─ db/migrations/
└─ src-tauri/
```

### 4.1 LangGraph เข้าตอนไหน

M1 ใช้ runtime ธรรมดา ไม่ใส่ LangGraph **แต่มีเงื่อนไข:**
`runtime.py` ต้องเป็น async generator ที่ **yield event ออกมา ห้ามเรียก event bus เอง**
ตัว caller เป็นคนส่งเข้า bus แบบนี้ M4 จะเอา graph node มาห่อได้โดยไม่ต้องแก้ runtime

ผลที่ตามมาสามข้อ ต้องทำตั้งแต่ M1:

1. runtime yield **`EventDraft` = `{type, payload}` เท่านั้น ไม่มี `seq`, `ts`, `id`**
   เพราะสามอย่างนั้นเป็นของ bus คนเดียว (§2.3) → codegen ต้องออกให้ทั้งสองทรง
   (`EventDraft` และ `EventEnvelope`)
2. runtime yield ได้สองชนิด: sequenced draft กับ ephemeral frame (delta)
   **caller เป็นคนแยกทาง** — sequenced → bus → persist → broadcast,
   ephemeral → broadcast ตรง ๆ **ห้าม delta เข้า bus เด็ดขาด** (§7.1)
3. cancel ทำโดย caller **ปิด generator** (`aclose()`) ไม่ใช่ให้ runtime คอยเช็ค flag เอง
   → runtime ต้องครอบ stream ของ provider ด้วย `async with` เพื่อให้ปิดได้สะอาด
   ไม่ทิ้ง connection ค้าง

### 4.2 Sidecar และ config

M1 รัน backend เป็น process แยก (`npm run dev` ยิงทั้งคู่) ทำ PyInstaller sidecar จริงที่ M7
frontend อ่าน port และ token จาก handshake config ทางเดียว → สองโหมดใช้โค้ดเดียวกัน

### 4.3 ที่เก็บข้อมูล

- dev: `./.data/agent-studio.db`
- prod: `%APPDATA%\AgentStudio\` (Windows), `~/Library/Application Support/`, `~/.local/share/`
- สลับด้วย env var

พัฒนาบน Windows เป็นหลัก แต่**ห้ามเขียนอะไรที่ผูก Windows โดยไม่จำเป็น**
(keyring, path, PyInstaller ต้องแยก platform-specific ออกมาเป็นจุดเดียว)

---

## 5. Data model

### agents
```
id, name, title, role, backstory, personality_traits (json),
system_prompt, provider_id, model, sampling (json, nullable),
tools (json array of tool ids),
avatar_config (json: body, hair, outfit, palette),
total_missions,
created_at, updated_at, archived_at
```
`sampling` เป็น json ไม่ใช่ `temperature` column ตรง ๆ เพราะบาง model ไม่รับ sampling
parameter เลย (ดู §3.1) — provider เป็นคนตัดสินว่าจะส่งอะไรไป โดยดูจาก `capabilities`

`total_missions` นับจาก mission ที่จบจริงเท่านั้น — เป็นข้อเท็จจริง ไม่ใช่คะแนน
**ไม่มี `exp` และไม่มี `level`** (§1.1, §15 แถว 28)

### teams
```
id, name, description, emblem_config (json),
scene_layout_id TEXT,          -- string enum ของ layout built-in, validate ที่ app layer
default_budget (json),
created_at, updated_at, archived_at
```

### team_members
```
team_id, agent_id, seat_index, role_in_team ('leader'|'member'),
overrides (json: model, tool_subset, prompt_suffix — nullable)
PRIMARY KEY (team_id, agent_id)
UNIQUE (team_id, seat_index)                                  -- กันสไปรต์ทับกันใน M5
UNIQUE (team_id) WHERE role_in_team = 'leader'                -- partial index กัน leader เกิน 1
```
"อย่างน้อยหนึ่ง leader" บังคับที่ DB ไม่ได้ → เป็นหน้าที่ validator (ดู §5.2)

### missions
```
id, kind ('chat'|'mission'), team_id (nullable), goal, status,
budget (json), roster_snapshot (json),
started_at, ended_at, end_reason, result_summary
```

### mission_events  — append-only ตลอดกาล
```
id, mission_id, seq, ts, v, type, payload (json)
UNIQUE (mission_id, seq)
```

### artifacts
```
id, mission_id, agent_id, kind, path, created_at
```

### provider_profiles
```
id, kind, base_url, model, capabilities (json), verified_at
```

### 5.1 roster_snapshot — จุดที่สำคัญที่สุดในเอกสารนี้

ทีมอ้าง agent แบบ **reference** (แก้ agent แล้วทุกทีมเปลี่ยนตาม ไม่มี versioning)
แต่ mission ต้อง replay ย้อนหลังได้ สองอย่างนี้ขัดกันโดยตรง — แก้ด้วย snapshot ระดับ mission

ตอน mission เริ่ม เขียน `missions.roster_snapshot` ทันที เก็บ:
```json
[{ "agent_id", "name", "avatar_config", "seat_index", "role_in_team",
   "provider_id", "model", "tools", "system_prompt", "prompt_suffix" }]
```

**นี่คือ snapshot ของ mission ไม่ใช่ของ agent** จึงไม่ขัดกับ "อย่าทำ versioning"

**กติกาที่ห้ามละเมิด:** snapshot นี้คือ *effective config* ที่ resolve `team_members.overrides`
เข้าไปแล้ว → **ระหว่าง mission รัน ห้ามใครอ่านตาราง `agents` หรือ `team_members` เด็ดขาด**
runtime, timeline, และฉาก อ่านจาก snapshot ตัวเดียวเท่านั้น

ถ้าไม่ทำแบบนี้: replay จะแสดงชื่อผิด หน้าตาผิด, ถอดสมาชิกออกจากทีมแล้ว `seat_index` หายไปเลย
และ timeline จะโกหก — แสดง model ของ agent แต่จริง ๆ ยิงด้วย override

**สร้าง column นี้ใน migration แรกของ `missions` แม้ M1 จะยังไม่ได้ใช้**
เพราะพอถึง M6 ตารางจะมีข้อมูลจริงแล้ว migrate ทีหลังแพงกว่ามาก

### 5.2 กติกาทีม

- **Validator ตัวเดียว** คืน `severity: 'warn' | 'error'` ห้ามเขียน logic สองชุด
  - `save` ยอมรับทั้ง warn และ error (บันทึกทีมที่ยังไม่สมบูรณ์ได้)
  - `run` ยอมรับเฉพาะ warn (มี error = บล็อก)
- ตัวอย่าง error: ไม่มี leader, มี agent ที่ `archived_at` ไม่ null
- ตัวอย่าง warn: ไม่มีใครมี tool `web_search`, ทีมมีคนเดียว
- agent หนึ่งตัวอยู่ได้หลายทีม (many-to-many)
- ลบ agent/team ที่ถูกอ้างอยู่ → soft delete (`archived_at`) เท่านั้น

### 5.3 Export / import

- export ทีมเป็น JSON ไฟล์เดียว ฝัง agent definition ไปด้วย + มี `schema_version`
- **export ห้ามมี API key เด็ดขาด** (มี test บังคับ)
- import: **สร้าง id ใหม่เสมอ** + เก็บ `source_id` ไว้ ถ้าเจอซ้ำค่อยขึ้น dialog ให้ผู้ใช้เลือก
- ทีมที่มี agent archived: export ได้ แต่ run ไม่ได้

---

## 6. Event schema

### 6.1 Envelope — รูปทรงทางการ

ตรงกับตาราง `mission_events` แบบ 1:1

```ts
interface EventEnvelope {
  v: number            // schema version — มีตั้งแต่ event แรก
  id: string           // uuid, ใช้ dedupe ตอน resume
  missionId: string
  seq: number          // แจกโดย event bus เท่านั้น
  ts: string           // ประทับโดย event bus เท่านั้น (นาฬิกาคนละ process จะเรียงผิด)
  draft: EventDraft    // ตัวที่ runtime yield ออกมา ไม่ถูกแตะเลย
}

type EventDraft =      // discriminated union ตาม type
  | { type: "mission.started"; payload: PayloadMissionStarted }
  | { type: "agent.message";   payload: PayloadAgentMessage }
  | ...
```

**ทำไม `draft` ถึงซ้อนอยู่ข้างใน ไม่ใช่แบน ๆ เป็น `type` + `payload` ที่ระดับบนสุด**

สองเหตุผล เหตุผลที่สองคือเหตุผลที่บังคับ:

1. มันทำให้กฎ §4.1 เป็นเรื่องของโครงสร้าง ไม่ใช่แค่ข้อตกลง — envelope คือ draft
   ที่ runtime yield ออกมา **แบบไม่ถูกแตะเลย** บวกห้า field ที่มีแต่ bus เท่านั้นที่ใส่ได้
2. **ทรงแบนสร้าง code ผิดจริง** ลองแล้วทั้งสอง generator: เขียนเป็น
   `allOf: [EnvelopeMeta, DraftX]` แล้ว `datamodel-code-generator` จะเอา**ชื่อคลาส**
   ไปทับ const ของ `type` (ได้ `type: Literal['EnvMissionStarted']` แทนที่จะเป็น
   `Literal['mission.started']`) → discriminator พังเงียบ ๆ ส่วน
   `json-schema-to-typescript` ก็ไม่ยอม emit `EventDraft` ออกมาเลย
   ทรงซ้อนสร้างถูกทั้งคู่โดยไม่ต้องเขียน meta field ซ้ำ 14 รอบ

**ยังตรงกับตาราง `mission_events` แบบ 1:1 เหมือนเดิม:** meta เป็น column,
`draft.type` ลง column `type`, `draft.payload` ลง column `payload`

**กติกาการเปลี่ยน schema: additive เท่านั้น** — เพิ่ม field ที่ optional, เพิ่ม type ใหม่, เพิ่มค่า enum
ห้ามลบ ห้ามเปลี่ยนความหมาย เพราะ vN ต้องอ่าน event ที่เขียนโดย v1 ได้เสมอ

### 6.2 Payload

```ts
type EventPayload =
  // mission lifecycle
  | { type: "mission.started";  kind: "chat"|"mission"; teamId?: string; goal: string }
  | { type: "mission.progress"; taskId: string; label: string;
      state: "pending"|"running"|"done"|"failed"; done: number; total: number }
  | { type: "mission.ended";
      reason: "completed"|"failed"|"budget_exceeded"|"cancelled"|"crashed";
      summary: string }

  // agent
  | { type: "agent.status";     agentId: string;
      status: "idle"|"thinking"|"working"|"waiting"|"blocked" }
  | { type: "agent.thought";    agentId: string; text: string }
  | { type: "agent.message";    agentId: string; messageId: string;
      to: Recipient; content: string; usage?: Usage }

  // tools
  | { type: "agent.tool.start"; agentId: string; callId: string; tool: string;
      input: unknown; truncated?: boolean }
  | { type: "agent.tool.end";   agentId: string; callId: string; ok: boolean;
      summary: string; durationMs: number;
      error?: { code: string; message: string }; usage?: Usage; truncated?: boolean }

  // human in the loop
  | { type: "user.message";     content: string }
  | { type: "agent.request";    agentId: string; requestId: string;
      kind: "question"|"approval"; question: string; options?: string[] }
  | { type: "agent.request.resolved"; requestId: string; answer: string;
      resolvedBy: "user"|"timeout"|"cancelled" }

  // อื่น ๆ
  | { type: "artifact.created"; agentId: string; artifactId: string;
      path: string; kind: "code"|"doc"|"image" }
  | { type: "budget.warning";   kind: "tokens"|"llm_calls"|"supersteps"|"time";
      used: number; limit: number }
  | { type: "error";            agentId?: string; code: string;
      message: string; recoverable: boolean }

type Recipient =
  | { kind: "agent"; id: string }
  | { kind: "user" }
  | { kind: "broadcast" }

type Usage = {
  inputTokens: number         // token ที่ไม่ได้มาจาก cache
  outputTokens: number
  cacheReadTokens?: number    // อ่านจาก cache — ถูกกว่า input มาก
  cacheWriteTokens?: number   // เขียนลง cache — แพงกว่า input
  costUsd?: number            // optional — provider บางเจ้าไม่บอกราคา
}
```

**หมายเหตุสำคัญ:**

- `agent.thought` = **scratchpad ที่ agent เขียนเองใน ReAct loop** ไม่ใช่ hidden CoT ของโมเดล
  (provider หลายเจ้าไม่คืน raw reasoning) ถ้านิยามผิดจะทำข้าม provider ไม่ได้จริง
- `to` เป็น object ไม่ใช่ magic string `"user"` — กัน namespace ชนกับ agentId และรองรับ broadcast
- `usage` ใส่ในทุก event ที่เกิดจากการเรียก LLM — budget guard ต้องนับอยู่แล้ว และตารางเป็น
  append-only ถ้าไม่เก็บตอนนี้จะไม่มีข้อมูลย้อนหลังทำหน้าสรุปค่าใช้จ่ายเลย
  และเป็น **ค่าใช้จ่ายจริงที่ผู้ใช้ต้องเห็น** — แสดงเป็นจำนวน token กับเงิน ไม่ใช่แถบพลัง (§1.1)
- **cache read กับ cache write คิดเงินคนละเรตและคนละทิศ** (read ถูกกว่า input, write แพงกว่า)
  ถ้ายุบเป็น `cachedInputTokens` ตัวเดียว จะคำนวณ `costUsd` ย้อนหลังไม่ได้เลย
  และตารางเป็น append-only แปลว่าแก้ทีหลังไม่ได้
- **ราคาต่อ 1M token อยู่ใน config ไม่ใช่ในโค้ด** และมี `pricing_as_of` กำกับ
  ถ้าไม่มีราคาของ model นั้นในตาราง ให้ `costUsd` ว่างไว้ **ห้ามเดา**
- approval เป็น `kind` หนึ่งของ `agent.request` ไม่ใช่ event ตระกูลใหม่

---

## 7. Transport

### 7.1 สองช่องแยกกันเด็ดขาด

| ช่อง | persist | seq | ใช้กับ |
|---|---|---|---|
| **sequenced** | ใช่ | ใช่ | event ทั้งหมดใน §6.2 |
| **ephemeral** | ไม่ | **ไม่มีเลย** | `agent.message.delta` |

```ts
// ephemeral — ไม่อยู่ใน envelope ปกติ ไม่มี seq
{ channel: "ephemeral", type: "agent.message.delta",
  missionId, agentId, messageId, index: number, text: string }
```

**ห้าม delta กิน seq เด็ดขาด** — ถ้ากิน พอ client resume ด้วย `since_seq` จะเห็นเลขขาด
แล้วเข้าใจผิดว่าตัวเองพลาด event ไป

replay ใช้ `agent.message` ตัวเต็มพอ ไม่ต้องเก็บ delta หลักพันแถวต่อ mission

### 7.2 Resume protocol

- client ต่อ WS พร้อม `?since_seq=N` → server ส่ง event ที่ `seq > N` ตามลำดับ แล้วต่อ live
- client **ต้อง dedupe ด้วย `id`** ตอน resume (อาจได้ตัวซ้ำที่ขอบ)
- ลำดับที่ห้ามสลับ: **persist ก่อน แล้วค่อย broadcast**
  ถ้า broadcast ก่อนแล้ว persist พัง ฉากจะเห็น event ที่ replay ไม่มี = desync ที่ debug ไม่ได้
- ใส่ตั้งแต่ M1 เพราะมันคือ shape ของ transport ทั้งเส้น

### 7.3 REST

- `GET /health`
- `GET /tools` — tool registry เสิร์ฟจาก backend (frontend ไม่ต้องรู้ล่วงหน้า
  จะได้มีสัญญาที่ต้อง sync แค่อันเดียวคือ events)
- `GET /providers`, `POST /providers/{id}/test`
- `POST /missions`, `POST /missions/{id}/cancel`  ← **M1**
- `POST /requests/{requestId}/resolve`

---

## 8. Forward compatibility

frontend ต้อง degrade ไม่ crash เมื่อเจอค่าที่ไม่รู้จัก **ทุกที่**:

- event `type` ไม่รู้จัก → แถว fallback ใน timeline
- `agent.status` ค่าที่ไม่รู้จัก → default pose ในฉาก
- enum ใด ๆ ที่ไม่รู้จัก → ค่ากลาง ไม่ throw
- `v` สูงกว่าที่รู้จัก → ยังต้อง render field ที่รู้จักได้

**เขียนเป็น test case ไม่ใช่แค่ comment**

---

## 9. Security

### 9.1 Auth

backend เป็น HTTP server บน localhost ที่ถือกุญแจ keychain อยู่ ถ้าไม่มี auth
เว็บเพจไหนก็ได้ที่ผู้ใช้เปิดใน browser ยิง `fetch('http://127.0.0.1:PORT/chat')` ได้
= ใช้ API key ของผู้ใช้เผาเงินได้ (WebSocket ไม่ติด CORS ด้วยซ้ำ)

- bind `127.0.0.1` เท่านั้น
- token สุ่มต่อการเปิดแอปหนึ่งครั้ง ตรวจทั้ง REST และ WS handshake
- **ห้ามส่งทาง argv** (มองเห็นได้จาก process list ของ user อื่น) และห้ามใส่ env var
- ทางหลัก: **parent process สุ่ม token แล้วป้อนให้ backend ทาง stdin บรรทัดแรก**
  (dev = `scripts/dev.mjs`, prod = Tauri) — ทำงานเหมือนกันทุก OS
- ⚠️ **"permission 0600" ใช้ไม่ได้บน Windows** — `os.chmod` บน Windows แตะได้แค่ read-only bit
  ไม่ใช่ ACL ถ้าจะใช้ไฟล์ handshake จริง ต้องเขียนลงโฟลเดอร์ per-user (`%LOCALAPPDATA%`)
  ที่ ACL จำกัดอยู่แล้ว แล้วยังต้องตั้ง ACL เองด้วย API เฉพาะแพลตฟอร์ม
  ซึ่งเป็นงานที่ไม่ต้องทำเลยถ้าใช้ stdin
- ⚠️ **stdin ใช้กับ `uvicorn --reload` ไม่ได้** (reloader spawn subprocess ใหม่ stdin หาย)
  → ใช้ entrypoint ของเราเอง (`python -m agentd`) ที่อ่าน stdin ก่อนแล้วค่อยเรียก `uvicorn.run()`
  ให้ `scripts/dev.mjs` เป็นตัว restart แทน reloader

### 9.2 Credential

**Python ถือ keyring คนเดียว Tauri ไม่เคยเห็น key** ห้ามอ่าน key ใน Rust แล้วส่งทาง env

### 9.3 Redaction

`agent.tool.start.input` ลงตาราง append-only ตลอดกาล และอาจมีเนื้อไฟล์หรือ secret ที่ agent อ่านเจอ

- ทำ redaction + truncation **ที่ event bus จุดเดียว** ไม่ใช่กระจายตาม tool
- ตัดที่ **8KB ต่อ payload** ตั้ง `truncated: true`

---

## 10. Budget

แยกเป็นสี่ตัว ไม่รวมเป็น "turn" เดียว เพราะนิยามกำกวม:

```
max_llm_calls, max_supersteps, max_tokens, timeout_sec
```

- precedence: `mission > team.default_budget > app default`
- `budget.warning` ยิงที่ **80%** ไม่ใช่ตอนชนแล้ว
- ชนเพดาน → **หยุดจริง** จบด้วย `mission.ended.reason = "budget_exceeded"`
  ยังไม่ต้องถามผู้ใช้ว่าจะต่อเวลาไหม (ฟีเจอร์ extend ไว้ทีหลัง)
- ผู้ใช้กดหยุดได้เสมอ → `reason = "cancelled"`

### 10.1 นับ token ยังไง ในเมื่อ output รู้ผลตอน stream จบ

`output_tokens` รู้ค่าจริงตอนจบ stream เท่านั้น จึงบังคับให้:

- **ก่อนยิงทุก call** — ประเมิน input ด้วย token counting แล้วเทียบงบที่เหลือ ไม่พอ = ไม่ยิง
- **clamp `max_tokens` ของแต่ละ call ด้วยงบที่เหลือ** ห้ามให้ call เดียวกินงบทั้ง mission
  (นี่คือตัวกันทะลุจริง ไม่ใช่การเช็คหลังบ้าน)
- **หลังจบทุก call** — บวก usage จริงเข้า running total แล้วเช็คซ้ำ
- `budget.warning` ที่ 80% จึงยิง **ตรงรอยต่อระหว่าง call** ไม่ใช่กลาง stream
  ยอมรับได้เพราะ clamp กันทะลุไว้แล้ว
- **ยิง `budget.warning` ครั้งเดียวต่อ kind ต่อ mission** ห้ามยิงรัว

---

## 11. โฟลหลัก

**สร้าง agent ด้วย AI** — ผู้ใช้กรอก role + prompt สั้น → LLM คืนโปรไฟล์เต็มแบบ structured output
`avatar_config` ต้อง **เลือกจาก asset ที่มีอยู่** ไม่ใช่ generate รูป
→ แสดงให้ผู้ใช้แก้ก่อนบันทึกเสมอ ห้ามบันทึกอัตโนมัติ

**สร้างทีม** — team builder: roster ซ้าย, seat ขวา, ลากเข้าไปได้
validator แสดง warn/error แบบ inline บันทึกแล้วขึ้นเป็นการ์ดในหน้า Team library

**รันภารกิจ** — เลือกทีม → พิมพ์ goal → **เขียน roster_snapshot** → leader วางแผนและกระจายงาน
→ ทุกสเต็ปยิง event ผ่าน bus → persist → broadcast → frontend
event ตัวเดียวกันถูกบริโภคสองที่: `features/timeline` และ `scene/bindings`

**Human-in-the-loop** — `interrupt()` หยุด graph แล้ว checkpoint → ยิง `agent.request`
→ ผู้ใช้ตอบ → ยิง `agent.request.resolved` → `resume()` ต่อจากจุดเดิม
ต้องรอดแม้ปิดแอปแล้วเปิดใหม่

---

## 12. Milestones

ห้ามข้าม แต่ละอันต้องรันได้จริงก่อนไปต่อ

### M1 — โครงและท่อ
chat กับ agent เดียว โดย chat = **degenerate mission** (`kind='chat'`, `team_id=null`)
เพื่อให้ได้ timeline, replay, budget, cancel มาฟรีทั้งชุด

ส่ง: เชลล์ + backend + `features/settings` (ใส่ API key, จัดการ provider) + `features/chat`
+ event bus + WS resume + `POST /missions/{id}/cancel`

เกณฑ์ผ่าน:
- เปิดแอปครั้งแรก → onboarding → ใส่ key → test connection ผ่านและ**รายงานผลทีละ 4 ข้อ** (§3.1)
- ส่งข้อความ → เห็นคำตอบ stream ทีละ token → **ปิดแอปเปิดใหม่ key ยังอยู่**
- สลับ DeepSeek ↔ Anthropic ได้จาก config โดยไม่แตะโค้ดใน `runtime.py`
- กดหยุดกลาง stream ได้ จบด้วย `reason = "cancelled"` และ connection ไม่ค้าง
- ยิง request โดยไม่มี token → ถูกปฏิเสธ ทั้ง REST และ WS
- ไม่มี key อยู่ใน repo, localStorage, SQLite, argv หรือ env

pytest 5 ตัว:
1. event ordering — `seq` ต่อเนื่อง ไม่ซ้ำ ไม่ข้าม, persist ก่อน broadcast
2. budget — ชนเพดานแล้วหยุดจริง + `budget.warning` ยิงที่ 80% ครั้งเดียวต่อ kind
3. codegen sync — schema เปลี่ยนแล้ว TS/Pydantic ต้อง regenerate ตรงกัน
4. WS resume — ยิง 10 event, ตัดการเชื่อมต่อกลาง, ต่อใหม่ด้วย `since_seq`
   ต้องได้ครบ ไม่ซ้ำ ไม่ขาด (dedupe ด้วย `id`)
5. secret hygiene — grep ทั้ง repo ไม่เจอ key pattern, มี `.env.example` แต่ไม่มี `.env`,
   export payload ไม่มี key

vitest 1 ตัว (ข้อยกเว้นของกฎ "frontend test เริ่ม M4" — ดู §13):
6. forward compatibility ของ decoder — event type ไม่รู้จัก / status ไม่รู้จัก / `v` สูงกว่า
   ต้องไม่ throw และยัง render field ที่รู้จักได้

### M2 — Agent
CRUD + AI generate profile + หน้า roster แบบการ์ดตัวละคร
เกณฑ์: สร้าง agent จาก prompt เดียวได้ แก้แล้วเซฟลง SQLite ได้

### M3 — Teams
สร้าง/บันทึก/แก้/ลบ/ทำสำเนา/export/import หลายทีม + validator (save=เตือน)
เกณฑ์: มี 3 ทีมพร้อมกัน สลับใช้ได้ agent ซ้ำข้ามทีมได้ export แล้วไม่มี key ในไฟล์

### M4 — Orchestration
LangGraph + timeline + budget guard เต็ม + `roster_snapshot` ทำงานจริง + validator (run=บล็อก)
เกณฑ์:
- ทีม 3 คนทำงานร่วมกันจนจบ log อ่านรู้เรื่อง
- แก้ agent หลัง mission จบ → replay ยังแสดงชื่อและ avatar ตอนนั้นถูกต้อง
- รัน mission ชุดเดียวกันด้วย DeepSeek และ Anthropic แล้วเทียบผล
  (เพื่อแยกว่าปัญหามาจาก orchestrator หรือจาก model)

### M5 — ฉาก
PixiJS: ตัวละครยืนตามโต๊ะ เปลี่ยนท่าตาม event ยังไม่ต้องเดิน
เกณฑ์: status ที่ไม่รู้จัก → default pose ไม่ crash

### M6 — HITL
approval + artifact viewer + replay จาก `mission_events`
เกณฑ์: อนุมัติกลางทางได้ ปิดแอปเปิดใหม่แล้วยังตอบ request เดิมได้ เปิดภารกิจเก่ามาดูซ้ำได้

### M7 — ขัดและ package
เดิน, speech bubble, เสียง, กล้อง, PyInstaller sidecar, ติดตั้งได้

---

## 13. สิ่งที่ยังไม่ต้องทำ

- 3D / โมเดล .glb
- Multi-user, sync, cloud
- Agent versioning และ diff (roster_snapshot ไม่ใช่ versioning)
- Budget extend / ต่อเวลากลาง mission
- ตาราง `layouts` (ใช้ string enum ไปก่อน)
- Plugin system สำหรับ tool ภายนอก
- i18n (เขียน string อังกฤษไปก่อน แต่แยกเป็นไฟล์ constant ให้ถอดง่าย)
- frontend test แบบ component / E2E (เริ่มที่ M4)
  **ยกเว้น** test ของ decoder ใน `transport/` ที่ต้องมีตั้งแต่ M1 เพราะ §8 บังคับให้
  forward compatibility เป็น test case ไม่ใช่ comment และ decoder เป็น pure function
  ไม่ใช่ component test

---

## 14. วิธีทำงาน

- เปลี่ยนแปลงทีละก้อนเล็ก ๆ ที่รันได้ ไม่ generate ทั้งโปรเจกต์รวดเดียว
- อะไรที่ไม่แน่ใจ ถาม อย่าเดา
- ถ้าเจอว่าข้อกำหนดในไฟล์นี้ผิดหรือทำไม่ได้จริง **บอกตรง ๆ พร้อมเหตุผล**
  อย่าเงียบแล้วทำอย่างอื่นแทน — รีวิวรอบแรกที่ทำให้เอกสารนี้เป็น v2 คือตัวอย่างที่ดี
- จบทุก milestone อัปเดต `CLAUDE.md`: สิ่งที่ตัดสินใจไป สิ่งที่พัง สิ่งที่ session ถัดไปควรรู้

---

## 15. บันทึกการตัดสินใจ

| # | เรื่อง | ตัดสิน | เหตุผล |
|---|---|---|---|
| 1 | reference vs snapshot | reference + `roster_snapshot` ระดับ mission | replay ต้องตรง โดยไม่ต้องทำ versioning |
| 2 | overrides resolve ที่ไหน | ตอน mission start ลง snapshot | ไม่งั้น timeline โกหก |
| 3 | delta persist ไหม | ไม่ + ไม่มี seq | ตารางบวม และ resume จะเห็นเลขขาด |
| 4 | chat มี mission ไหม | degenerate mission | ได้ timeline/replay/budget/cancel ฟรี |
| 5 | envelope vs flat union | envelope | ตรงกับ DB 1:1 codegen สวยทั้งสองฝั่ง |
| 6 | schema version | มีตั้งแต่ event แรก | append-only ตลอดกาล ใส่ทีหลังต้อง migrate ประวัติศาสตร์ |
| 7 | progress percent | เปลี่ยนเป็น done/total + state | % ของ agent workflow คำนวณจริงไม่ได้ |
| 8 | mission.ended | เพิ่ม `reason` 5 ค่า | ฉากกับ timeline ต้องแสดงต่างกัน |
| 9 | cancel อยู่ milestone ไหน | **M1** ไม่ใช่ M4 | chat เป็น mission แล้ว ต้องหยุด stream ได้ตั้งแต่แรก |
| 10 | ใครแจก seq/ts | event bus คนเดียว | agent ขนานกันใน M4 จะชนกัน นาฬิกาคนละ process เรียงผิด |
| 11 | tool registry sync ยังไง | backend เสิร์ฟ REST | มีสัญญาที่ต้อง sync แค่ events อันเดียว |
| 12 | ~~level เก็บไหม~~ | **ยกเลิก** — ไม่มีทั้ง level และ exp | ดูแถว 28 |
| 13 | validator กี่ตัว | ตัวเดียว คืน severity | save/run ใช้ logic ชุดเดียวกัน |
| 14 | ใครถือ key | Python เท่านั้น ผ่าน keyring | Tauri ส่งทาง env = key อยู่ใน process environment |
| 15 | usage tracking | ใส่ตั้งแต่ M1 | budget นับอยู่แล้ว + append-only เก็บทีหลังไม่ได้ + เป็นค่าใช้จ่ายจริงที่ผู้ใช้ต้องเห็น |
| 16 | provider ตัวไหนก่อน | **DeepSeek / OpenAI-compatible** | ราคา — แต่ผลของการเลือกไปโผล่ที่ M2 (structured output) ไม่ใช่ M1 จึงต้อง retry+validate เสมอ |
| 17 | ยิง Anthropic ผ่าน shim ได้ไหม | **ไม่ได้** ต้องใช้ `anthropic` SDK | ทรง request/response คนละอย่าง จะเพี้ยนเงียบ ๆ |
| 18 | `agents.temperature` | เปลี่ยนเป็น `sampling` json nullable | Sonnet 5 ถอด temperature ออกแล้ว ส่งไปได้ 400 |
| 19 | ประกอบ request ยังไง | ขับด้วย `capabilities` | model คนละตัวใน provider เดียวกันก็รับคนละทรง ไม่ใช่แค่คนละ provider |
| 20 | model id | ไม่ hardcode + verify ด้วย `GET /v1/models` | id ที่มีอยู่ในเอกสารยืนยันไม่ได้ทั้งหมด อย่าเดา |
| 21 | usage cache field | แยก read / write | คิดเงินคนละเรตคนละทิศ ยุบเป็นตัวเดียวแล้วคำนวณย้อนหลังไม่ได้ |
| 22 | ส่ง token ยังไง | stdin เท่านั้น | 0600 ไม่มีความหมายบน Windows, stdin เหมือนกันทุก OS |
| 23 | runtime yield อะไร | `EventDraft` ไม่มี seq/ts/id | seq กับ ts เป็นของ bus คนเดียว (§2.3) |
| 24 | cancel ทำยังไง | caller ปิด generator | runtime ไม่ต้องรู้จัก cancel flag → M4 ห่อด้วย graph node ได้เลย |
| 25 | forward-compat test | vitest ที่ decoder ตั้งแต่ M1 | §8 บังคับให้เป็น test และ decoder เป็น pure function ไม่ใช่ component |
| 26 | envelope ทรงไหน | `draft` ซ้อนข้างใน ไม่ใช่ `type`+`payload` แบน | ทรงแบน (`allOf`) ทำให้ datamodel-codegen เอาชื่อคลาสไปทับ const ของ `type` → discriminator พังเงียบ ๆ ทดสอบแล้วจริง (§6.1) |
| 27 | pin formatter ของ codegen | `--formatters black isort` | ค่า default กำลังจะเปลี่ยน ถ้าไม่ pin วันหนึ่ง `codegen:check` จะ fail พร้อมกันทุกเครื่องโดยไม่มีใครแก้ schema |
| 28 | **ถอย gamification ออก** | ลบ level/exp ทิ้งทั้งหมด (migration 0004) เก็บ `total_missions`, usage, avatar, การ์ดตัวละคร, ธีมสีเข้ม | ธีมเกมอยู่ที่รูปลักษณ์ ไม่ใช่ระบบตัวเลข **exp เป็นคะแนนที่เราแต่งขึ้น** — มันไม่ได้บอกอะไรจริงเกี่ยวกับ agent ตัวนั้น การแสดงมันคือการทำให้ UI โกหก ซึ่ง §1 ห้ามอยู่แล้ว ส่วน `total_missions` กับ token/เงิน เป็นข้อเท็จจริงที่วัดได้ จึงเก็บไว้ **อย่าเสนอ level/exp/MP/HP กลับเข้ามาอีก — เกณฑ์อยู่ที่ §1.1** |

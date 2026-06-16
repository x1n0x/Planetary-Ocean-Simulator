# TASKS — Planetary Ocean Simulator

> **How to use:** работай сверху вниз. Не начинай фазу пока предыдущая не закрыта.  
> **[V]** = Vlad · **[K]** = Kirill · **[both]** = координируетесь вместе  
> Копируй чекбоксы в GitHub Issues или веди прямо здесь.

---

## Phase 0 — Setup
> **Цель:** оба могут запустить что-то локально  
> **Дедлайн:** Days 1–2

- [x] **[both]** Создать репо `Planetary-Ocean-Simulator`, добавить `CLAUDE.md`, `README.md`, `TASKS.md`
- [x] **[both]** Согласовать ветки: `main` защищён, фичи через `feat/FE-*`, `feat/BE-*`, `feat/PHY-*`
- [x] **[V]** Скаффолдить `backend/` — FastAPI, пустые роутеры, `uvicorn main:app --reload` запускается без ошибок
- [x] **[V]** Скаффолдить `frontend/` — Vite + React + TS, все зависимости из CLAUDE.md §7.2 установлены, `npm run dev` открывается
- [x] **[V]** Запустить скрипт fake zarr (CLAUDE.md §13) → `backend/data/scenario_test_*/` создан
- [x] **[V]** `GET /scenarios` и `GET /state` возвращают JSON из fake zarr
- [x] **[K]** Dedalus v3 установлен, `import dedalus.public as d3` работает
- [x] **[K]** SWE на плоском периодическом домене (без сферы), zarr output соответствует схеме CLAUDE.md §4

**✅ Phase 0 готова когда:**
```bash
curl "localhost:8000/state?scenario=scenario_test_moon384km_omega1x_temp15&t=0"
# возвращает { eta: [[...]], u: [[...]], ... }
```
и у Кирилла Dedalus генерирует zarr.

---

## Phase 1 — Globe + Basic Heatmap
> **Цель:** видим океан на глобусе  
> **Дедлайн:** Week 1–2

- [x] **[V]** `Globe.tsx` — CesiumJS viewer, тёмный фон (ink `#100f0c`), без стандартного imagery
- [x] **[V]** Fetch `GET /state` при t=0, `etaToTexture()` на глобусе (синий/белый/красный) + 3D wave mesh
- [x] **[V]** Fetch `GET /land` один раз — сейчас рендерится как 3D рельефная суша (`landMesh.ts`)
- [x] **[V]** Базовый лейаут: глобус на всю высоту, сайдбар-страница справа
- [x] **[K]** Сфера в Dedalus — `SphereBasis` (не `S2Basis`!), SWE 100 шагов без дивергенции
- [x] **[K]** Кориолис — полная сфера `f(φ) = 2Ω·sin(φ)` через `MulCosine(skew(u))`

**✅ Phase 1 готова когда:** хитмап рендерится на глобусе из fake данных, у Кирилла SWE на сфере стабильна.

---

## Phase 2 — Timeline + Controls
> **Цель:** пользователь играет с симуляцией  
> **Дедлайн:** Week 3–4  
> ⚠️ **Критическая точка:** Кирилл сдаёт первый реальный zarr к концу этой фазы

- [x] **[V]** Timeline slider внизу (t: 0 → T_total_steps), кнопка play/pause
- [x] **[V]** Prebuilt playback — кадры пред-генерируются, слайдер мгновенно переключает (вместо throttle-fetch)
- [x] **[V]** Loading indicator во время fetch
- [x] **[V]** Control panel — 4 слайдера:
  - Moon distance: 192k – 1152k km
  - Moon mass: 0 – 3× Moon
  - Rotation Ω: 0.1× – 5× Earth ← новый в v2
  - Temperature: −10°C – +30°C
- [x] **[V]** `nearestScenario()` — при изменении слайдера выбирается ближайший сценарий
- [x] **[V]** `OmegaBadge` — показывает текущий Ω относительно Земли
- [x] **[V]** `GET /scenarios` → frontend показывает список доступных сценариев
- [x] **[K]** Переменная топография `H_b(λ,φ)` — рифты снижают высоту волны над ними
- [x] **[K]** Приливное форсирование от одной луны — `U_tidal` из позиции луны, η показывает прилив
- [x] **[K]** Валидация: equilibrium tide η₀ ≈ **0.36 м** (не 0.27 м!)
- [x] **[K]** **Первый реальный сценарий записан в zarr и передан Владу** ← критический deliverable

**✅ Phase 2 готова когда:** слайдер меняется → сценарий переключается → хитмап обновляется. Реальный zarr получен.

---

## Phase 3 — Real Data + Anomaly L1 + L3
> **Цель:** реальная физика видна, первые детекторы аномалий работают  
> **Дедлайн:** Week 5–6

- [x] **[V]** Заменить fake zarr на реальный от Кирилла — 6 сценариев в `backend/data/`, оси совпадают (fix `8d5dbf3`)
- [x] **[V]** Velocity vector layer — стрелки течений на ocean cells, land cells пропускаются (Cesium PolylineCollection)
- [x] **[V]** `detect_threshold()` в `services/anomaly.py` с wet mask (chi < 0.5)
- [x] **[V]** `GET /anomaly` endpoint подключён
- [x] **[V]** `anomalyToTexture()` — красный оверлей на аномальных ячейках
- [x] **[V]** `EnergyChart` в сайдбаре — E_k и E_p по времени (свой SVG-спарклайн вместо Plotly)
- [x] **[V]** `detect_energy_spike()` — красные X-маркеры на спайках энергии
- [x] **[K]** Volume penalization χ работает — холмы выше уровня воды отражают волны
- [x] **[K]** `chi.zarr` включён в output — Vlad рендерит terrain
- [x] **[K]** Несколько сценариев с разными Ω — 0.1×, 1×, 3×, 5× Earth

**✅ Phase 3 готова когда:** реальные волны видны, красный оверлей аномалий появляется, energy chart показывает спайки.

---

## Phase 4 — Isolation Forest + Polish + Deploy
> **Цель:** полный DS модуль, проект выглядит как продукт  
> **Дедлайн:** Week 7–8

- [x] **[V]** Написать `scripts/train_iso_forest.py` — читает zarr, тренирует на 80%, сохраняет joblib
- [x] **[V]** Натренировать Isolation Forest на реальных сценариях → `backend/models/scenario.joblib` (4.6M сэмплов с 6 сценариев)
- [x] **[V]** `detect_isolation()` подключён в `/anomaly` endpoint — проверено end-to-end, `isolation_scores` непустые
- [x] **[V]** Composite anomaly overlay (threshold OR isolation forest) — `Globe.tsx` рендерит `composite_mask`
- [x] **[V]** Anomaly count badge в сайдбаре ("12 anomalous cells") — chip в HUD + счётчик на тоггле
- [x] **[V]** Scenario library UI — карточки доступных сценариев (`App.tsx` scenario-list)
- [ ] **[V]** Deploy на Railway ← остаётся
- [x] **[K]** Поддержка нескольких лун — суперпозиция `U_tidal`
- [x] **[K]** 20+ precomputed сценариев покрывают весь диапазон слайдеров
- [x] **[K]** Energy conservation validation: E_total drift < 0.1% за 100 шагов
- [x] **[K]** Land reflection validation: волна отражается, без глобального Gibbs ringing

**✅ Phase 4 готова когда:** полный демо запускается, аномалии работают на реальных данных, задеплоено.

---

## Buffer — Stretch Goals
> Если останется время

- [ ] **[V]** WebGL water shader — реалистичная поверхность океана
- [ ] **[V]** Mobile layout
- [ ] **[K]** SST модуль — тепловой слой, морская поверхностная температура
- [ ] **[K]** High-res сценарии 256×128
- [ ] **[both]** Live рисование топографии — пользователь лепит морское дно в реальном времени

---

## Dependency Graph

```
Phase 0 (setup)
    │
    ├─[V]─ Phase 1 (globe + heatmap)       ─[K]─ Phase 1 (sphere SWE)
    │           │                                       │
    ├─[V]─ Phase 2 (timeline + sliders)    ─[K]─ Phase 2 (tidal forcing)
    │           │                                       │
    │           └──────────── 📦 реальный zarr ────────┘
    │                               │
    ├─[V]─ Phase 3 (real data + anomaly L1+L3)
    │           │
    └─[V]─ Phase 4 (isolation forest + deploy)
```

**Критический путь:** Кирилл сдаёт первый zarr к концу Phase 2 (Week 4).  
Всё после этого разблокируется этим файлом.

---

## Quick Reference — важные числа

| Параметр | Значение |
|---|---|
| Mean ocean depth H₀ | 4000 m |
| Gravity wave speed c | ≈ 198 m/s |
| Earth rotation Ω | 7.292 × 10⁻⁵ rad/s |
| Earth-Moon distance | 384 000 km |
| Equilibrium tide η₀ | **0.36 m** (v2 corrected) |
| Grid dev | 32 × 32 |
| Grid production | 128 × 64 |
| Timestep | 1800 s (30 min) |
| Steps per year | ~17 500 |
| Anomaly threshold k | 3.0σ |
| Energy spike ratio α | 3.0 |
| zarr chunk | (1, lat, lon) |

---

*TASKS.md — Planetary Ocean Simulator. Updated: June 2026.*

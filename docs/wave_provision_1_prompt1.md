# Wave PROVISION-1 · Промпт ① — node_runtime: cloud-init (self-install + self-register)

Репо: **node_runtime** (`Tmwyw/node_runtime`), но канонический origin для clone-at-boot —
remote `new` → `https://github.com/Tmwyw/node_runtime_new.git`. Текущая ветка-исток
`wave/node-mgmt-2-agent` идентична `new/main` (`55bd5e1`), v2-скрипты закоммичены на
`new/main`. Backup-ветка: `backup/provision-1-prompt1-pre` @ `55bd5e1`. Рабочая ветка:
`wave/provision-1`.

Вариант **B**: юзер сам создаёт чистый Vultr-сервер и вставляет cloud-init как user_data;
нода при первом boot ставит себя сама и регистрируется на оркестраторе — без SSH, без
ручной установки. Орк инстанс НЕ создаёт. cloud-init только ВЫЗЫВАЕТ запечённые v2-скрипты,
логику не дублирует.

---

## ПОДГОТОВКА — что запекают install-скрипты (прочитано построчно)

### `install_node_v2.sh` (570 строк, точное имя подтверждено)
- **Entrypoint:** `bash install_node_v2.sh [--clean] [--remove-legacy-root]`. `set -euo pipefail`.
  Требует root (`EUID==0`, иначе `die must_run_as_root`).
- **Флаги (подтверждены):**
  - `--clean` → прогоняет `scripts/clean_node.sh` ПЕРЕД установкой.
  - `--remove-legacy-root` → совместно с `--clean` удаляет ещё и `/root/proxyserver`
    (передаётся в `clean_node.sh --remove-legacy-root`).
  - Cloud-init вызывает с **обоими** (`--clean --remove-legacy-root`) — чистая нода,
    но скрипт идемпотентен на повторный boot.
- **Что запекает** (main(), порядок):
  1. `disable_ufw` — purge ufw + mask.
  2. `pin_dns_resolvers` — install-time resolv.conf (1.1.1.1/8.8.8.8, immutable).
  3. `configure_file_limits` — 1M FD, nproc unlimited (limits.d + systemd system.conf.d).
  4. `configure_colored_prompt`.
  5. `install_os_dependencies` — `curl wget jq ca-certificates nftables`.
  6. **`configure_unbound`** — локальный рекурсивный резолвер; resolv.conf → 127.0.0.1
     (recursion egress = node IP, geo/ASN-consistent), 1.1.1.1 как last-resort.
     ⚠️ Комментарий в скрипте: **этот билд 3proxy ИГНОРИРУЕТ директиву `nserver`** и резолвит
     через `/etc/resolv.conf` — т.е. реальный рычаг DNS = unbound+resolv.conf, а `nserver`
     в генераторе cfg = no-op. (Это и есть «генератор nserver» из вопроса — он есть, но не
     влияет; DNS-egress держит unbound.)
  7. `install_nodejs_20_if_needed`.
  8. `copy_repo_to_opt` → `/opt/netrun`; `install_runtime_files` (3proxy binary из
     `deploy/node/bin/3proxy`).
  9. **`configure_sysctl`** — pid_max/threads-max = 4194304; **Android TCP-отпечаток**:
     `tcp_timestamps=1` (Linux/Android-дефолт; =0 читался p0f как Windows),
     `tcp_mtu_probing=1` (PLPMTUD вместо фикс. MSS-clamp).
  10. **`configure_nftables`** — flush inherited ruleset (иначе xt-compat от ufw ломает
      `nft -f` на boot), таблицы `proxy_normalization`/`proxy_accounting`, **MSS-clamp 1460**
      (не 1340 — 1340 давал MTU=1380 → p0f=OpenVPN).
  11. `write_bootstrap_marker`, `ensure_legacy_root_proxyserver_symlink`.
  12. **`install_systemd_service`** — `netrun-node-agent` (drop-in 99-netrun-limits: TasksMax
      infinity, NOFILE 1M, NPROC infinity) → enable + restart.
  13. **`install_3proxy_restore_unit`** — `netrun-3proxy-restore` (bounded parallel `xargs -P 4`
      + setsid detach — лечит fork-bomb инцидента 2026-05-15).
  14. `install_doctor_script` → `/opt/netrun/scripts/netrun-doctor.sh`.
  15. **`verify_health`** — ждёт `http://127.0.0.1:8085/health` (`success==true && status==ready`),
      30 попыток × 1с; **`die health_check_failed` (exit 1)** если не поднялось.
- ⚠️ **Exit-код значим:** `verify_health` падает → installer выходит ≠0. Cloud-init ловит это
  и всё равно шлёт callback с `ok=false` (см. ЭТАП C).

### `scripts/node_followup_v2.sh` (329 строк, точное имя подтверждено)
- **Entrypoint:** `bash scripts/node_followup_v2.sh` (без флагов). `set -euo pipefail`.
- Находит 3proxy (`/opt/netrun/proxyserver/3proxy/...` и др.); `fail` (exit 1) если бинарь
  не найден (но installer его уже положил → ок при последовательном вызове).
- **Что запекает:**
  - kernel sysctl + ulimits (дубль-strap к installer'у, идемпотентно).
  - `netrun-3proxy-restore.service` (bounded parallel, TasksMax infinity).
  - **`netrun-watchdog` v3 (timer 60с)** — ⚠️ **двух-ярусный, НЕ «non-rebooting»** (хедер
    install_node_v2 строка 567 говорит «non-rebooting», но фактический followup_v2 ставит v3):
    - Tier 1: 5 подряд фейлов `/health` → `systemctl restart netrun-node-agent` (cooldown 10 мин).
    - Tier 2: 20 подряд фейлов (~20 мин downtime) → `reboot` (cooldown 4 ч) — лечит
      Vultr abuse-network-block.
  - bump лимитов node-agent.service если стоит.

**Вывод для cloud-init:** просто `bash install_node_v2.sh --clean --remove-legacy-root`
затем `bash scripts/node_followup_v2.sh`, оба под root (cloud-init и так root), захватить
их exit-коды, дёрнуть `/health`/register. Никакой логики установки не дублируем.

---

## ЭТАП A — cloud-init шаблон

Файл: `deploy/node/cloud-init.sh` (+ опц. `deploy/node/cloud-init.yaml` обёртка).

Шаги (соответствуют промпту 1–7):
1. `apt-get update && apt-get install -y git curl ca-certificates` (+ `jq` — нужен для
   безопасной JSON-сборки callback'а даже когда installer упал ДО своей установки jq;
   минимальное оправданное отклонение, зафиксировано в REPORT).
2. `git clone https://github.com/Tmwyw/node_runtime_new.git` → `/root/node_runtime_new`.
3. `bash install_node_v2.sh --clean --remove-legacy-root` — зафиксировать `INSTALL_RC`.
4. `bash scripts/node_followup_v2.sh` — зафиксировать `FOLLOWUP_RC` (только если install ok).
5. `INSTALL_OK = (INSTALL_RC==0 && FOLLOWUP_RC==0)`; `LOG_TAIL = tail -n 30` provision-лога.
6. `SELF_IP = curl https://ifconfig.me` (fallback Vultr metadata `169.254.169.254/v1/...`).
7. callback `POST __ORCH_URL__/v1/nodes/register` (retry 3× backoff на network/5xx).

**Плейсхолдеры (грепаемые, замена ДО отдачи в Vultr — в B это делает бот):**
`__ORCH_URL__`, `__SECRET__` (one-time per-job), `__JOB_ID__` (опц., для логов).

---

## ЭТАП B — КОНТРАКТ POST /v1/nodes/register

> Единственная точка стыка ноды и оркестратора. Промпт ② реализует ТОЧНО так.

**Метод/путь:** `POST {ORCH_URL}/v1/nodes/register`
**Headers:** `Content-Type: application/json` — **БЕЗ `X-NETRUN-API-KEY`** (нода ещё не
зарегистрирована, ключа у неё нет).
**Auth-модель:** сервер берёт `body.secret`, считает `sha256(secret)` и сверяет с
`node_provisions.shared_secret_hash` (one-time per-job секрет, выданный при генерации
user_data). Совпало → регистрирует/апдейтит ноду; не совпало → `401/403`.

**Тело запроса (body):**
| поле | тип | описание |
|------|-----|----------|
| `ip` | str | публичный IPv4 ноды (ifconfig.me / Vultr metadata) |
| `secret` | str | one-time per-job секрет из user_data; сервер сверяет sha256 |
| `install_result.ok` | bool | `true` ⇔ install_node_v2 И node_followup_v2 вышли с 0 |
| `install_result.exit_code` | int | код упавшего шага (install приоритетнее), 0 при успехе |
| `install_result.log_tail` | str | последние ~30 строк `/var/log/netrun-provision.log` |
| `hostname` | str | `$(hostname)` |
| `agent_version` | str | `git rev-parse --short HEAD` клонированного репо |

**Пример JSON:**
```json
{
  "ip": "203.0.113.45",
  "secret": "b3f1c9e2a7d04f88b1e6c5a2f9d8e7c6",
  "install_result": {
    "ok": true,
    "exit_code": 0,
    "log_tail": "[install_node_v2] Install v2 complete\n[followup-v2] Follow-up v2 complete on netrun-tokyo-01\n..."
  },
  "hostname": "netrun-tokyo-01",
  "agent_version": "55bd5e1"
}
```

Partial-failure пример (installer упал на health-check):
```json
{
  "ip": "203.0.113.45",
  "secret": "b3f1c9e2a7d04f88b1e6c5a2f9d8e7c6",
  "install_result": { "ok": false, "exit_code": 1, "log_tail": "...health_check_failed..." },
  "hostname": "netrun-tokyo-01",
  "agent_version": "55bd5e1"
}
```
Оркестратор по `ok=false` помечает provision как partial-failed (не висит в `installing`).

---

## ЭТАП C — устойчивость + докзы

- install/followup упал → callback ВСЁ РАВНО уходит с `ok=false` + `log_tail` (cloud-init
  глушит `set -e` вокруг install-шагов, захватывает коды, доходит до register).
- Секрет в user_data — ок (Vultr metadata, per-job, one-shot, на сервере только sha256).
  ⚠️ Cloud-init **не трейсит секрет в лог** (`set +x` вокруг register-секции) — иначе он попал
  бы в `/var/log/netrun-provision.log` и далее в `log_tail` callback'а.
- shellcheck чистый.
- README: `docs/cloud_init_provisioning.md`.

---

## Журнал прогресса
- **A** (commit `05deb75`) — `deploy/node/cloud-init.sh` + journal scaffold (ПОДГОТОВКА +
  ЭТАП A/B/C). shellcheck 0.10.0 чисто. Blob = pure LF (0 CR, `file` → shell script).
  jq-payload провалидирован (ok→bool, exit_code→int, log_tail escape).
- **B** — контракт `/v1/nodes/register` зафиксирован выше (документ-only, влит в commit A).
  Промпт ② реализует ТОЧНО так.
- **C** (commit pending) — `deploy/node/cloud-init.yaml` (опц. #cloud-config обёртка,
  base64-embed без дублирования), `docs/cloud_init_provisioning.md` (README: генерация
  user_data / контракт / security-модель секрета / каветы), `.gitattributes` (`*.sh eol=lf`
  — защита от CRLF на будущих правках). Устойчивость (callback на failure, set +x вокруг
  секрета) реализована в .sh ещё в commit A.
- **НЕ запушено** (жду «ок пуш»). Backup: `backup/provision-1-prompt1-pre` @ `55bd5e1`.

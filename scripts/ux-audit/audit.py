"""Harness de auditoria visual do console (specs/60-ux-reforma/61).

Captura as telas de screens.py em 2 viewports contra um wrangler dev local
(ou outra base via env) e grava PNGs + manifest.json em OUT_ROOT/<phase>/.

Uso:
  python scripts/ux-audit/audit.py --phase baseline
  python scripts/ux-audit/audit.py --phase wave-4 --only 03-board,04-task-detail

Env:
  UX_AUDIT_BASE      base URL (default http://localhost:8787)
  UX_AUDIT_EMAIL     e-mail de login (obrigatório; dev local usa a credencial
                     de teste pública do vitest.config.ts)
  UX_AUDIT_PASSWORD  senha de login (obrigatório)
  UX_AUDIT_OUT       raiz de saída (default C:/tmp/ux-audit)

Credenciais NUNCA são hardcoded aqui — o repo é público. O login é feito UMA
vez por execução (o endpoint tem rate-limit) e o storage state é reusado nos
dois viewports. Telas anônimas (login, /s/<token>) usam contexto sem cookies.
"""

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).parent))
from screens import SCREENS, VIEWPORTS  # noqa: E402

BASE = os.environ.get("UX_AUDIT_BASE", "http://localhost:8787").rstrip("/")
OUT_ROOT = Path(os.environ.get("UX_AUDIT_OUT", "C:/tmp/ux-audit"))


def die(msg: str) -> None:
    print(f"ERRO: {msg}", file=sys.stderr)
    sys.exit(1)


def git_sha() -> str:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=Path(__file__).resolve().parents[2], text=True).strip()
    except Exception:
        return "unknown"


def login(context, email: str, password: str) -> None:
    page = context.new_page()
    page.goto(f"{BASE}/app/login", wait_until="domcontentloaded")
    page.fill('input[name="email"]', email)
    page.fill('input[name="password"]', password)
    with page.expect_navigation():
        page.click('button[type="submit"]')
    if "/app/login" in page.url:
        die("login falhou — confira UX_AUDIT_EMAIL/UX_AUDIT_PASSWORD e o wrangler dev")
    page.close()


def discover_ids(context) -> dict:
    """Descobre ids de task/nota/contato e um link /s/ válido, preferindo seed-*."""
    ids: dict = {}
    page = context.new_page()

    # task: via /app/tasks/data scope=board ({columns:[{tasks:[...]}]}), preferindo seed-*
    try:
        r = page.request.get(f"{BASE}/app/tasks/data")
        if r.ok:
            cols = (r.json().get("columns")) or []
            tasks = [t for c in cols for t in (c.get("tasks") or [])]
            if tasks:
                seed = [t for t in tasks if str(t.get("id", "")).startswith("seed-")]
                ids["task"] = (seed or tasks)[0]["id"]
    except Exception as exc:
        print(f"  discover task: {exc}", file=sys.stderr)

    # nota: primeiro link de detalhe na lista /app/notes que NÃO seja a task
    try:
        page.goto(f"{BASE}/app/notes", wait_until="domcontentloaded")
        page.wait_for_timeout(1200)
        hrefs = page.eval_on_selector_all(
            'a[href^="/app/notes/"]',
            "els => els.map(e => e.getAttribute('href'))")
        for h in hrefs:
            tail = h.split("/app/notes/")[-1]
            if "/" in tail or "?" in tail or tail in ("", ids.get("task")):
                continue
            ids["note"] = tail
            break
    except Exception as exc:
        print(f"  discover note: {exc}", file=sys.stderr)

    # contato: via /app/contacts/data ({nodes:[{id,...}]}) — a landing é um canvas
    # de grafo sem <a>, então DOM scraping não encontra nada ali.
    try:
        r = page.request.get(f"{BASE}/app/contacts/data")
        if r.ok:
            nodes = (r.json().get("nodes")) or []
            if nodes:
                seed = [n for n in nodes if str(n.get("id", "")).startswith("seed-")]
                ids["contact"] = (seed or nodes)[0]["id"]
    except Exception as exc:
        print(f"  discover contact: {exc}", file=sys.stderr)

    # link público: share na task descoberta (renova se já existir — dev local)
    try:
        if "task" in ids:
            headers = {"origin": BASE, "content-type": "application/json"}
            r = page.request.post(f"{BASE}/app/tasks/share",
                                  data=json.dumps({"id": ids["task"]}), headers=headers)
            body = r.json() if r.ok else {}
            if body.get("already_shared"):
                r = page.request.post(
                    f"{BASE}/app/tasks/share",
                    data=json.dumps({"id": ids["task"], "renew": True}), headers=headers)
                body = r.json() if r.ok else {}
            url = body.get("url")
            if url:
                # normaliza pra path — o shot monta BASE + path
                from urllib.parse import urlparse
                if "://" in url:
                    ids["share"] = urlparse(url).path
                else:
                    ids["share"] = url if url.startswith("/") else "/" + url
    except Exception as exc:
        print(f"  discover share: {exc}", file=sys.stderr)

    page.close()
    return ids


def shot(context, screen: dict, viewport_name: str, out_dir: Path, ids: dict) -> dict:
    slug = screen["slug"]
    fname = f"{slug}--{viewport_name}.png"
    entry = {"screen": slug, "viewport": viewport_name, "file": fname, "ok": False}
    page = context.new_page()
    try:
        path = screen["path"](ids) if callable(screen["path"]) else screen["path"]
        page.goto(f"{BASE}{path}", wait_until="domcontentloaded", timeout=30000)
        page.evaluate("document.fonts.ready")
        if screen.get("wait_hidden"):
            try:
                page.wait_for_selector(screen["wait_hidden"], state="hidden", timeout=15000)
            except Exception:
                entry["warn"] = f"wait_hidden timeout: {screen['wait_hidden']}"
        if screen.get("action") == "palette":
            page.keyboard.press("Control+k")
            page.wait_for_timeout(400)
        page.wait_for_timeout(screen.get("settle_ms", 500))
        page.screenshot(path=str(out_dir / fname), full_page=screen.get("full_page", True))
        entry["ok"] = True
        entry["url"] = path
    except Exception as exc:  # tela quebrada também é dado — registra e segue
        entry["error"] = str(exc)[:300]
        try:
            page.screenshot(path=str(out_dir / fname), full_page=False)
            entry["file_partial"] = True
        except Exception:
            pass
    finally:
        page.close()
    return entry


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--phase", required=True, help="nome da fase (baseline, wave-4, final...)")
    ap.add_argument("--only", default="", help="lista de slugs separada por vírgula")
    args = ap.parse_args()

    email = os.environ.get("UX_AUDIT_EMAIL")
    password = os.environ.get("UX_AUDIT_PASSWORD")
    if not email or not password:
        die("defina UX_AUDIT_EMAIL e UX_AUDIT_PASSWORD (credencial de teste local)")

    only = {s.strip() for s in args.only.split(",") if s.strip()}
    screens = [s for s in SCREENS if not only or s["slug"] in only]
    out_dir = OUT_ROOT / args.phase
    out_dir.mkdir(parents=True, exist_ok=True)

    manifest = {
        "phase": args.phase, "base": BASE, "git_sha": git_sha(),
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "shots": [],
    }

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        state_path = out_dir / "_storage-state.json"

        # contexto logado (desktop) — login único, estado salvo e reusado
        probe = browser.new_context(reduced_motion="reduce", locale="pt-BR",
                                    timezone_id="America/Sao_Paulo")
        login(probe, email, password)
        ids = discover_ids(probe)
        probe.storage_state(path=str(state_path))
        probe.close()
        manifest["ids"] = ids

        for vp_name, vp in VIEWPORTS.items():
            common = dict(viewport=vp, reduced_motion="reduce", locale="pt-BR",
                          timezone_id="America/Sao_Paulo",
                          is_mobile=(vp_name == "mobile"), has_touch=(vp_name == "mobile"))
            ctx_auth = browser.new_context(storage_state=str(state_path), **common)
            ctx_anon = browser.new_context(**common)
            for screen in screens:
                if screen["needs"] and screen["needs"] not in ids:
                    manifest["shots"].append({
                        "screen": screen["slug"], "viewport": vp_name, "ok": False,
                        "error": f"id '{screen['needs']}' não descoberto"})
                    continue
                ctx = ctx_auth if screen["logged_in"] else ctx_anon
                manifest["shots"].append(shot(ctx, screen, vp_name, out_dir, ids))
                print(f"  [{vp_name}] {screen['slug']}"
                      f" {'ok' if manifest['shots'][-1]['ok'] else 'FALHOU'}")
            ctx_auth.close()
            ctx_anon.close()

        browser.close()
        state_path.unlink(missing_ok=True)  # cookie de sessão não fica em disco

    ok = sum(1 for s in manifest["shots"] if s["ok"])
    manifest["summary"] = f"{ok}/{len(manifest['shots'])} capturas ok"
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n{manifest['summary']} -> {out_dir}")
    if ok == 0:
        sys.exit(1)


if __name__ == "__main__":
    main()

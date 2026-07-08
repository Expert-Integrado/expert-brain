"""Gera contact sheet HTML comparando duas fases da auditoria visual.

Uso:
  python scripts/ux-audit/contact_sheet.py --phase wave-4 --against baseline
  python scripts/ux-audit/contact_sheet.py --phase baseline          (sheet simples)

Lê OUT_ROOT/<phase>/manifest.json e gera OUT_ROOT/<phase>/contact-sheet.html
com as imagens lado a lado (referência à esquerda, fase atual à direita),
agrupadas por tela, com os dois viewports. Caminhos relativos — abre direto
no browser a partir da pasta.
"""

import argparse
import json
import os
import sys
from pathlib import Path

OUT_ROOT = Path(os.environ.get("UX_AUDIT_OUT", "C:/tmp/ux-audit"))


def load_manifest(phase: str) -> dict:
    p = OUT_ROOT / phase / "manifest.json"
    if not p.exists():
        print(f"ERRO: {p} não existe — rode audit.py --phase {phase} antes", file=sys.stderr)
        sys.exit(1)
    return json.loads(p.read_text(encoding="utf-8"))


def img_cell(phase: str, fname: str, current_phase: str) -> str:
    fs_path = OUT_ROOT / phase / fname
    if not fs_path.exists():
        return '<div class="missing">sem captura</div>'
    rel = fname if phase == current_phase else f"../{phase}/{fname}"
    return f'<a href="{rel}" target="_blank"><img loading="lazy" src="{rel}"></a>'


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--phase", required=True)
    ap.add_argument("--against", default="", help="fase de referência (ex.: baseline)")
    args = ap.parse_args()

    cur = load_manifest(args.phase)
    ref = load_manifest(args.against) if args.against else None

    # agrupa por tela: {slug: {viewport: shot}}
    def by_screen(man):
        out = {}
        for s in man["shots"]:
            out.setdefault(s["screen"], {})[s["viewport"]] = s
        return out

    cur_map = by_screen(cur)
    ref_map = by_screen(ref) if ref else {}
    slugs = sorted(set(cur_map) | set(ref_map))

    cols = f"{args.against} · referência|{args.phase} · atual" if ref else args.phase
    rows = []
    for slug in slugs:
        for vp in ("desktop", "mobile"):
            cshot = cur_map.get(slug, {}).get(vp)
            fname = cshot["file"] if cshot and cshot.get("file") else f"{slug}--{vp}.png"
            err = f'<p class="err">{cshot["error"]}</p>' if cshot and cshot.get("error") else ""
            cells = ""
            if ref:
                cells += f'<td>{img_cell(args.against, fname, args.phase)}</td>'
            cells += f'<td>{img_cell(args.phase, fname, args.phase)}{err}</td>'
            rows.append(f'<tr><th>{slug}<br><small>{vp}</small></th>{cells}</tr>')

    head_cells = "".join(f"<th>{c}</th>" for c in cols.split("|"))
    html = f"""<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<title>UX audit · {args.phase}</title>
<style>
  body {{ font: 14px system-ui, sans-serif; margin: 16px; background: #16161c; color: #e8e8ee; }}
  h1 {{ font-size: 18px; }}
  table {{ border-collapse: collapse; width: 100%; }}
  th, td {{ border: 1px solid #333; padding: 6px; vertical-align: top; text-align: left; }}
  img {{ max-width: 100%; display: block; background: #000; }}
  td {{ width: {"46%" if ref else "88%"}; }}
  .missing {{ color: #888; padding: 24px; }}
  .err {{ color: #ff8080; font-size: 12px; }}
  small {{ color: #999; }}
</style></head><body>
<h1>UX audit · fase <code>{args.phase}</code>{f' vs <code>{args.against}</code>' if ref else ''}</h1>
<p>{cur.get("summary", "")} · sha {cur.get("git_sha", "?")} · {cur.get("started_at", "")}</p>
<table><tr><th>tela</th>{head_cells}</tr>
{chr(10).join(rows)}
</table></body></html>"""

    out = OUT_ROOT / args.phase / "contact-sheet.html"
    out.write_text(html, encoding="utf-8")
    print(f"contact sheet -> {out}")


if __name__ == "__main__":
    main()

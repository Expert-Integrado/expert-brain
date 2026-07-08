"""Inventário de telas do console pra auditoria visual (specs/60-ux-reforma/61).

Cada tela é um dict:
  slug        — nome do arquivo PNG (sem viewport)
  path        — rota, ou callable(ids) -> rota quando depende de id descoberto
  needs       — chave de id necessária ('task' | 'note' | 'contact' | 'share'), ou None
  logged_in   — captura no contexto logado (True) ou anônimo (False)
  full_page   — screenshot da página inteira (False pra canvas/overlay)
  settle_ms   — espera extra após o load (animações, canvas)
  action      — ação especial antes do shot: 'palette' abre Ctrl+K
  wait_hidden — seletor que precisa estar hidden antes do shot (ex.: loading do grafo)
"""

VIEWPORTS = {
    "desktop": {"width": 1440, "height": 900},
    "mobile": {"width": 390, "height": 844},
}

SCREENS = [
    {"slug": "01-login", "path": "/app/login", "needs": None, "logged_in": False,
     "full_page": True, "settle_ms": 300},
    {"slug": "02-home", "path": "/app", "needs": None, "logged_in": True,
     "full_page": True, "settle_ms": 1500},
    {"slug": "03-board", "path": "/app/tasks", "needs": None, "logged_in": True,
     "full_page": True, "settle_ms": 1200},
    {"slug": "04-task-detail", "path": lambda ids: f"/app/notes/{ids['task']}",
     "needs": "task", "logged_in": True, "full_page": True, "settle_ms": 1200},
    {"slug": "05-notes-lista", "path": "/app/notes", "needs": None, "logged_in": True,
     "full_page": True, "settle_ms": 800},
    {"slug": "06-note-detail", "path": lambda ids: f"/app/notes/{ids['note']}",
     "needs": "note", "logged_in": True, "full_page": True, "settle_ms": 1200},
    {"slug": "07-journal", "path": "/app/journal", "needs": None, "logged_in": True,
     "full_page": True, "settle_ms": 1000},
    {"slug": "08-inbox", "path": "/app/inbox", "needs": None, "logged_in": True,
     "full_page": True, "settle_ms": 800},
    {"slug": "09-contacts", "path": "/app/contacts", "needs": None, "logged_in": True,
     "full_page": False, "settle_ms": 2000},
    {"slug": "10-contact-page", "path": lambda ids: f"/app/contacts/{ids['contact']}",
     "needs": "contact", "logged_in": True, "full_page": True, "settle_ms": 1500},
    {"slug": "11-graph", "path": "/app/graph", "needs": None, "logged_in": True,
     "full_page": False, "settle_ms": 4500, "wait_hidden": "#graph-center-loading"},
    {"slug": "12-config", "path": "/app/config", "needs": None, "logged_in": True,
     "full_page": True, "settle_ms": 800},
    {"slug": "13-api-keys", "path": "/app/api-keys", "needs": None, "logged_in": True,
     "full_page": True, "settle_ms": 500},
    {"slug": "14-novidades", "path": "/app/novidades", "needs": None, "logged_in": True,
     "full_page": True, "settle_ms": 500},
    {"slug": "15-share-publico", "path": lambda ids: ids["share"],
     "needs": "share", "logged_in": False, "full_page": True, "settle_ms": 800},
    {"slug": "16-palette", "path": "/app/notes", "needs": None, "logged_in": True,
     "full_page": False, "settle_ms": 500, "action": "palette"},
]

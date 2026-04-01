.PHONY: dev build up down logs lint restart status

dev:
	cd app && uvicorn main:app --host 0.0.0.0 --port 8111 --reload --loop asyncio

build:
	docker compose build

up:
	docker compose up -d

down:
	docker compose down

restart:
	docker compose up -d --build

logs:
	docker compose logs -f --tail=100

lint:
	cd app && python -m py_compile config.py db.py main.py middleware.py models.py parser.py poller.py quality.py ws.py routes/api.py routes/pages.py
	@echo "All files OK"

status:
	@curl -s http://localhost:8111/api/health | python3 -m json.tool

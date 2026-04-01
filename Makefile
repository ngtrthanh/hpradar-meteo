.PHONY: dev build up down logs lint

dev:
	cd app && uvicorn main:app --host 0.0.0.0 --port 8000 --reload

build:
	docker compose build

up:
	docker compose up -d

down:
	docker compose down

logs:
	docker compose logs -f --tail=100

lint:
	cd app && python -m py_compile main.py config.py models.py parser.py db.py poller.py quality.py middleware.py routes/api.py routes/pages.py
	@echo "All files OK"

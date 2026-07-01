.PHONY: dev local test backend-test frontend-build docker-up docker-down

dev:
	docker-compose up --build

local:
	./run.sh

test: backend-test frontend-build

backend-test:
	cd backend && PYTHONPATH=. pytest

frontend-build:
	cd frontend && npm run build

docker-up:
	docker-compose up --build

docker-down:
	docker-compose down

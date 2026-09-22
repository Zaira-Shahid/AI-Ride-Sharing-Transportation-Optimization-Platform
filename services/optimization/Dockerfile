# Cloud Run image for the optimization service (Module 6.0). Built and pushed by the deployer
# by hand for now (no CI wired up yet), the same stage the rest of the project's deployment is at.
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# Cloud Run sets $PORT; uvicorn must listen on it, not a fixed port.
CMD exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8080}

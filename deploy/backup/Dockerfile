FROM postgres:18-alpine

RUN apk add --no-cache python3 py3-boto3

WORKDIR /backup
COPY --chown=postgres:postgres backup.py ./backup.py

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    AWS_EC2_METADATA_DISABLED=true \
    AWS_REQUEST_CHECKSUM_CALCULATION=when_required \
    AWS_RESPONSE_CHECKSUM_VALIDATION=when_required

USER postgres
ENTRYPOINT ["python3", "/backup/backup.py"]

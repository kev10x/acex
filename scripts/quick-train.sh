#!/bin/bash
# Quick training script - trains model directly from database

# Set database type (sqlite, mysql, postgresql)
export DB_TYPE=${DB_TYPE:-sqlite}

# For SQLite (default)
if [ "$DB_TYPE" = "sqlite" ]; then
    export DB_PATH=${DB_PATH:-./database.sqlite}
fi

# For MySQL
if [ "$DB_TYPE" = "mysql" ]; then
    export DB_HOST=${DB_HOST:-localhost}
    export DB_PORT=${DB_PORT:-3306}
    export DB_USER=${DB_USER:-root}
    export DB_PASSWORD=${DB_PASSWORD:-}
    export DB_NAME=${DB_NAME:-acexen}
fi

# For PostgreSQL
if [ "$DB_TYPE" = "postgresql" ]; then
    export DB_HOST=${DB_HOST:-localhost}
    export DB_PORT=${DB_PORT:-5432}
    export DB_USER=${DB_USER:-postgres}
    export DB_PASSWORD=${DB_PASSWORD:-}
    export DB_NAME=${DB_NAME:-acexen}
fi

# Run training
python3 scripts/train-from-database.py \
    --output ./models/acexen-model \
    --epochs 3 \
    --batch-size 8 \
    "$@"






@echo off
REM Quick training script for Windows - trains model directly from database

REM Set database type (sqlite, mysql, postgresql)
if "%DB_TYPE%"=="" set DB_TYPE=sqlite

REM For SQLite (default)
if "%DB_TYPE%"=="sqlite" (
    if "%DB_PATH%"=="" set DB_PATH=./database.sqlite
)

REM For MySQL
if "%DB_TYPE%"=="mysql" (
    if "%DB_HOST%"=="" set DB_HOST=localhost
    if "%DB_PORT%"=="" set DB_PORT=3306
    if "%DB_USER%"=="" set DB_USER=root
    if "%DB_PASSWORD%"=="" set DB_PASSWORD=
    if "%DB_NAME%"=="" set DB_NAME=markmate
)

REM For PostgreSQL
if "%DB_TYPE%"=="postgresql" (
    if "%DB_HOST%"=="" set DB_HOST=localhost
    if "%DB_PORT%"=="" set DB_PORT=5432
    if "%DB_USER%"=="" set DB_USER=postgres
    if "%DB_PASSWORD%"=="" set DB_PASSWORD=
    if "%DB_NAME%"=="" set DB_NAME=markmate
)

REM Run training
python scripts/train-from-database.py --output ./models/markmate-model --epochs 3 --batch-size 8 %*






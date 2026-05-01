@echo off
title Tesla Video Bypass — Baslatici (port 8004)
echo ======================================================
echo Uygulama: http://localhost:8004
echo ======================================================
echo [1/4] Mevcut uygulamalar temizleniyor...
echo ======================================================

:: Port 8004'u kullanan islemi bul ve sonlandir (LISTEN satirinin sonundaki PID)
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8004 ^| findstr LISTENING') do (
    taskkill /f /pid %%a >nul 2>&1
)

:: Python ve uvicorn islemlerini sonlandir (dikkatli olalim)
taskkill /f /im python.exe /t >nul 2>&1
taskkill /f /im uvicorn.exe /t >nul 2>&1

:: Docker container'lari varsa durdur (opsiyonel ama iyi olur)
docker-compose down >nul 2>&1

echo.
echo [2/4] Bagimliliklar kontrol ediliyor...
echo ======================================================
pip install -r requirements.txt

echo.
echo [3/4] Uygulama baslatiliyor... (Port: 8004)
echo ======================================================
start http://localhost:8004
python -m uvicorn app.main:app --host 0.0.0.0 --port 8004 --reload

echo.
echo [4/4] Uygulama calisiyor.
echo ======================================================
pause

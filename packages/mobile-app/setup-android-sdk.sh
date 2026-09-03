#!/usr/bin/env bash
# Descarga el Android SDK command-line tools mínimo necesario para compilar
# (no hace falta Android Studio completo). Pensado para correr una vez en
# Replit u otro entorno Linux sin SDK preinstalado.
set -euo pipefail

SDK_ROOT="${ANDROID_SDK_ROOT:-$HOME/android-sdk}"
CMDLINE_TOOLS_URL="https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"

mkdir -p "$SDK_ROOT/cmdline-tools"
cd "$SDK_ROOT/cmdline-tools"

if [ ! -d "latest" ]; then
  echo "Descargando Android command-line tools..."
  wget -q "$CMDLINE_TOOLS_URL" -O cmdline-tools.zip
  unzip -q cmdline-tools.zip
  mv cmdline-tools latest
  rm cmdline-tools.zip
fi

export PATH="$SDK_ROOT/cmdline-tools/latest/bin:$PATH"

yes | sdkmanager --sdk_root="$SDK_ROOT" --licenses > /dev/null || true
sdkmanager --sdk_root="$SDK_ROOT" "platform-tools" "platforms;android-34" "build-tools;34.0.0"

echo "Listo. Exportá estas variables (o agregalas a tu perfil de shell):"
echo "  export ANDROID_SDK_ROOT=$SDK_ROOT"
echo "  export ANDROID_HOME=$SDK_ROOT"
echo "  export PATH=\$ANDROID_SDK_ROOT/platform-tools:\$PATH"

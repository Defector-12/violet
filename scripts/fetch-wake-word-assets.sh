#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESTINATION="${ROOT_DIR}/apps/macos/.local-wake"
VERSION="1.13.6"
LIB_ARCHIVE="sherpa-onnx-v${VERSION}-osx-arm64-shared-no-tts-lib.tar.bz2"
LIB_SHA256="30dde4971d286decd7c952e006779531ad55306acabc7aa288f5625995b5ba74"
MODEL_ARCHIVE="sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2"
MODEL_SHA256="f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a"
LIB_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/v${VERSION}/${LIB_ARCHIVE}"
LICENSE_SHA256="cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30"
LICENSE_URL="https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/v${VERSION}/LICENSE"
MODEL_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/${MODEL_ARCHIVE}"

if [[ -f "${DESTINATION}/.ready" && -f "${DESTINATION}/ENGINE-LICENSE.txt" ]]; then
  printf '%s\n' "▁VI OL ET :2.0 #0.25 @VIOLET" >"${DESTINATION}/model/keywords.txt"
  printf '%s\n' "${DESTINATION}"
  exit 0
fi

temporary_directory="$(mktemp -d)"
trap 'rm -rf "$temporary_directory"' EXIT

curl --fail --location --silent --show-error \
  "${LIB_URL}" \
  --output "${temporary_directory}/${LIB_ARCHIVE}"
curl --fail --location --silent --show-error \
  "${MODEL_URL}" \
  --output "${temporary_directory}/${MODEL_ARCHIVE}"
curl --fail --location --silent --show-error \
  "${LICENSE_URL}" \
  --output "${temporary_directory}/ENGINE-LICENSE.txt"

printf '%s  %s\n' \
  "${LIB_SHA256}" \
  "${temporary_directory}/${LIB_ARCHIVE}" \
  | shasum --algorithm 256 --check
printf '%s  %s\n' \
  "${LICENSE_SHA256}" \
  "${temporary_directory}/ENGINE-LICENSE.txt" \
  | shasum --algorithm 256 --check
printf '%s  %s\n' \
  "${MODEL_SHA256}" \
  "${temporary_directory}/${MODEL_ARCHIVE}" \
  | shasum --algorithm 256 --check

tar -xjf "${temporary_directory}/${LIB_ARCHIVE}" -C "${temporary_directory}"
tar -xjf "${temporary_directory}/${MODEL_ARCHIVE}" -C "${temporary_directory}"

lib_source="${temporary_directory}/sherpa-onnx-v${VERSION}-osx-arm64-shared-no-tts-lib/lib"
model_source="${temporary_directory}/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"

rm -rf "${DESTINATION}"
mkdir -p "${DESTINATION}/lib" "${DESTINATION}/model"
install -m 0755 "${lib_source}/libsherpa-onnx-c-api.dylib" "${DESTINATION}/lib/"
install -m 0755 "${lib_source}/libonnxruntime.dylib" "${DESTINATION}/lib/"
install -m 0644 \
  "${model_source}/encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx" \
  "${DESTINATION}/model/encoder.onnx"
install -m 0644 \
  "${model_source}/decoder-epoch-12-avg-2-chunk-16-left-64.onnx" \
  "${DESTINATION}/model/decoder.onnx"
install -m 0644 \
  "${model_source}/joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx" \
  "${DESTINATION}/model/joiner.onnx"
install -m 0644 "${model_source}/tokens.txt" "${DESTINATION}/model/tokens.txt"
install -m 0644 "${model_source}/bpe.model" "${DESTINATION}/model/bpe.model"
install -m 0644 "${model_source}/README.md" "${DESTINATION}/MODEL-LICENSE.md"
install -m 0644 "${temporary_directory}/ENGINE-LICENSE.txt" "${DESTINATION}/"
printf '%s\n' "▁VI OL ET :2.0 #0.25 @VIOLET" >"${DESTINATION}/model/keywords.txt"
printf '%s\n' "${VERSION}" >"${DESTINATION}/.ready"

printf '%s\n' "${DESTINATION}"

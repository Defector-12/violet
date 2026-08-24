#include "CVioletWake.h"

#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct SherpaOnnxOnlineTransducerModelConfig {
  const char *encoder;
  const char *decoder;
  const char *joiner;
} SherpaOnnxOnlineTransducerModelConfig;

typedef struct SherpaOnnxOnlineParaformerModelConfig {
  const char *encoder;
  const char *decoder;
} SherpaOnnxOnlineParaformerModelConfig;

typedef struct SherpaOnnxOnlineZipformer2CtcModelConfig {
  const char *model;
} SherpaOnnxOnlineZipformer2CtcModelConfig;

typedef struct SherpaOnnxOnlineNemoCtcModelConfig {
  const char *model;
} SherpaOnnxOnlineNemoCtcModelConfig;

typedef struct SherpaOnnxOnlineToneCtcModelConfig {
  const char *model;
} SherpaOnnxOnlineToneCtcModelConfig;

typedef struct SherpaOnnxOnlineModelConfig {
  SherpaOnnxOnlineTransducerModelConfig transducer;
  SherpaOnnxOnlineParaformerModelConfig paraformer;
  SherpaOnnxOnlineZipformer2CtcModelConfig zipformer2_ctc;
  const char *tokens;
  int32_t num_threads;
  const char *provider;
  int32_t debug;
  const char *model_type;
  const char *modeling_unit;
  const char *bpe_vocab;
  const char *tokens_buf;
  int32_t tokens_buf_size;
  SherpaOnnxOnlineNemoCtcModelConfig nemo_ctc;
  SherpaOnnxOnlineToneCtcModelConfig t_one_ctc;
} SherpaOnnxOnlineModelConfig;

typedef struct SherpaOnnxFeatureConfig {
  int32_t sample_rate;
  int32_t feature_dim;
} SherpaOnnxFeatureConfig;

typedef struct SherpaOnnxKeywordSpotterConfig {
  SherpaOnnxFeatureConfig feat_config;
  SherpaOnnxOnlineModelConfig model_config;
  int32_t max_active_paths;
  int32_t num_trailing_blanks;
  float keywords_score;
  float keywords_threshold;
  const char *keywords_file;
  const char *keywords_buf;
  int32_t keywords_buf_size;
} SherpaOnnxKeywordSpotterConfig;

typedef struct SherpaOnnxKeywordSpotter SherpaOnnxKeywordSpotter;
typedef struct SherpaOnnxOnlineStream SherpaOnnxOnlineStream;

typedef struct SherpaOnnxKeywordResult {
  const char *keyword;
  const char *tokens;
  const char *const *tokens_arr;
  int32_t count;
  float *timestamps;
  float start_time;
  const char *json;
} SherpaOnnxKeywordResult;

typedef const SherpaOnnxKeywordSpotter *(*CreateSpotterFn)(
    const SherpaOnnxKeywordSpotterConfig *);
typedef void (*DestroySpotterFn)(const SherpaOnnxKeywordSpotter *);
typedef const SherpaOnnxOnlineStream *(*CreateStreamFn)(
    const SherpaOnnxKeywordSpotter *, const char *);
typedef void (*DestroyStreamFn)(const SherpaOnnxOnlineStream *);
typedef void (*AcceptWaveformFn)(const SherpaOnnxOnlineStream *, int32_t,
                                 const float *, int32_t);
typedef int32_t (*IsReadyFn)(const SherpaOnnxKeywordSpotter *,
                             const SherpaOnnxOnlineStream *);
typedef void (*DecodeFn)(const SherpaOnnxKeywordSpotter *,
                         const SherpaOnnxOnlineStream *);
typedef const SherpaOnnxKeywordResult *(*GetResultFn)(
    const SherpaOnnxKeywordSpotter *, const SherpaOnnxOnlineStream *);
typedef void (*DestroyResultFn)(const SherpaOnnxKeywordResult *);
typedef void (*ResetStreamFn)(const SherpaOnnxKeywordSpotter *,
                              const SherpaOnnxOnlineStream *);

struct VioletWakeEngine {
  void *onnx_handle;
  void *runtime_handle;
  const SherpaOnnxKeywordSpotter *spotter;
  const SherpaOnnxOnlineStream *stream;
  DestroySpotterFn destroy_spotter;
  DestroyStreamFn destroy_stream;
  AcceptWaveformFn accept_waveform;
  IsReadyFn is_ready;
  DecodeFn decode;
  GetResultFn get_result;
  DestroyResultFn destroy_result;
  ResetStreamFn reset_stream;
};

static void set_error(char *buffer, int32_t size, const char *message) {
  if (buffer && size > 0) {
    snprintf(buffer, (size_t)size, "%s", message ? message : "unknown error");
  }
}

static void *load_symbol(void *handle, const char *name) {
  dlerror();
  return dlsym(handle, name);
}

VioletWakeEngine *VioletWakeCreate(const char *assets_path, const char *keyword,
                                   char *error_buffer,
                                   int32_t error_buffer_size) {
  if (!assets_path || !keyword) {
    set_error(error_buffer, error_buffer_size,
              "wake-word configuration is incomplete");
    return NULL;
  }
  char runtime_library_path[4096];
  char onnxruntime_library_path[4096];
  char encoder_path[4096];
  char decoder_path[4096];
  char joiner_path[4096];
  char tokens_path[4096];
  char bpe_vocab_path[4096];
#define ASSET_PATH(destination, suffix)                                        \
  if (snprintf(destination, sizeof(destination), "%s/%s", assets_path,         \
               suffix) >= (int)sizeof(destination)) {                          \
    set_error(error_buffer, error_buffer_size,                                 \
              "wake-word asset path is too long");                             \
    return NULL;                                                               \
  }
  ASSET_PATH(runtime_library_path, "lib/libsherpa-onnx-c-api.dylib")
  ASSET_PATH(onnxruntime_library_path, "lib/libonnxruntime.dylib")
  ASSET_PATH(encoder_path, "model/encoder.onnx")
  ASSET_PATH(decoder_path, "model/decoder.onnx")
  ASSET_PATH(joiner_path, "model/joiner.onnx")
  ASSET_PATH(tokens_path, "model/tokens.txt")
  ASSET_PATH(bpe_vocab_path, "model/bpe.model")
#undef ASSET_PATH

  VioletWakeEngine *engine = calloc(1, sizeof(VioletWakeEngine));
  if (!engine) {
    set_error(error_buffer, error_buffer_size, "wake-word allocation failed");
    return NULL;
  }

  engine->onnx_handle =
      dlopen(onnxruntime_library_path, RTLD_NOW | RTLD_GLOBAL);
  if (!engine->onnx_handle) {
    set_error(error_buffer, error_buffer_size, dlerror());
    VioletWakeDestroy(engine);
    return NULL;
  }
  engine->runtime_handle = dlopen(runtime_library_path, RTLD_NOW | RTLD_LOCAL);
  if (!engine->runtime_handle) {
    set_error(error_buffer, error_buffer_size, dlerror());
    VioletWakeDestroy(engine);
    return NULL;
  }

#define LOAD(field, type, symbol)                                              \
  engine->field = (type)load_symbol(engine->runtime_handle, symbol);           \
  if (!engine->field) {                                                        \
    set_error(error_buffer, error_buffer_size, dlerror());                     \
    VioletWakeDestroy(engine);                                                 \
    return NULL;                                                               \
  }

  CreateSpotterFn create_spotter;
  CreateStreamFn create_stream;
  LOAD(destroy_spotter, DestroySpotterFn, "SherpaOnnxDestroyKeywordSpotter")
  LOAD(destroy_stream, DestroyStreamFn, "SherpaOnnxDestroyOnlineStream")
  LOAD(accept_waveform, AcceptWaveformFn,
       "SherpaOnnxOnlineStreamAcceptWaveform")
  LOAD(is_ready, IsReadyFn, "SherpaOnnxIsKeywordStreamReady")
  LOAD(decode, DecodeFn, "SherpaOnnxDecodeKeywordStream")
  LOAD(get_result, GetResultFn, "SherpaOnnxGetKeywordResult")
  LOAD(destroy_result, DestroyResultFn, "SherpaOnnxDestroyKeywordResult")
  LOAD(reset_stream, ResetStreamFn, "SherpaOnnxResetKeywordStream")
  create_spotter = (CreateSpotterFn)load_symbol(
      engine->runtime_handle, "SherpaOnnxCreateKeywordSpotter");
  create_stream = (CreateStreamFn)load_symbol(
      engine->runtime_handle, "SherpaOnnxCreateKeywordStreamWithKeywords");
  if (!create_spotter || !create_stream) {
    set_error(error_buffer, error_buffer_size, dlerror());
    VioletWakeDestroy(engine);
    return NULL;
  }
#undef LOAD

  SherpaOnnxKeywordSpotterConfig config;
  memset(&config, 0, sizeof(config));
  config.feat_config.sample_rate = 16000;
  config.feat_config.feature_dim = 80;
  config.model_config.transducer.encoder = encoder_path;
  config.model_config.transducer.decoder = decoder_path;
  config.model_config.transducer.joiner = joiner_path;
  config.model_config.tokens = tokens_path;
  config.model_config.num_threads = 1;
  config.model_config.provider = "cpu";
  config.model_config.modeling_unit = "bpe";
  config.model_config.bpe_vocab = bpe_vocab_path;
  config.max_active_paths = 4;
  config.num_trailing_blanks = 1;
  config.keywords_score = 1.5f;
  config.keywords_threshold = 0.35f;
  config.keywords_buf = keyword;
  config.keywords_buf_size = (int32_t)strlen(keyword);

  engine->spotter = create_spotter(&config);
  if (!engine->spotter) {
    set_error(error_buffer, error_buffer_size,
              "failed to create keyword spotter");
    VioletWakeDestroy(engine);
    return NULL;
  }
  engine->stream = create_stream(engine->spotter, keyword);
  if (!engine->stream) {
    set_error(error_buffer, error_buffer_size,
              "failed to create keyword stream");
    VioletWakeDestroy(engine);
    return NULL;
  }
  return engine;
}

int32_t VioletWakeAcceptInt16(VioletWakeEngine *engine, const int16_t *samples,
                              int32_t sample_count, int32_t sample_rate) {
  if (!engine || !engine->spotter || !engine->stream || !samples ||
      sample_count <= 0) {
    return -1;
  }
  float *normalized = malloc((size_t)sample_count * sizeof(float));
  if (!normalized) {
    return -1;
  }
  for (int32_t i = 0; i < sample_count; ++i) {
    normalized[i] = (float)samples[i] / 32768.0f;
  }
  engine->accept_waveform(engine->stream, sample_rate, normalized,
                          sample_count);
  free(normalized);

  while (engine->is_ready(engine->spotter, engine->stream)) {
    engine->decode(engine->spotter, engine->stream);
  }
  const SherpaOnnxKeywordResult *result =
      engine->get_result(engine->spotter, engine->stream);
  if (!result) {
    return -1;
  }
  int32_t detected = result->keyword && result->keyword[0] != '\0';
  engine->destroy_result(result);
  if (detected) {
    engine->reset_stream(engine->spotter, engine->stream);
  }
  return detected;
}

void VioletWakeDestroy(VioletWakeEngine *engine) {
  if (!engine) {
    return;
  }
  if (engine->stream && engine->destroy_stream) {
    engine->destroy_stream(engine->stream);
  }
  if (engine->spotter && engine->destroy_spotter) {
    engine->destroy_spotter(engine->spotter);
  }
  if (engine->runtime_handle) {
    dlclose(engine->runtime_handle);
  }
  if (engine->onnx_handle) {
    dlclose(engine->onnx_handle);
  }
  free(engine);
}

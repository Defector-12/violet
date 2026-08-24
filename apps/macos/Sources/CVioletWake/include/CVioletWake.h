#ifndef C_VIOLET_WAKE_H
#define C_VIOLET_WAKE_H

#include <stdint.h>

typedef struct VioletWakeEngine VioletWakeEngine;

VioletWakeEngine *VioletWakeCreate(const char *assets_path, const char *keyword,
                                   char *error_buffer,
                                   int32_t error_buffer_size);

int32_t VioletWakeAcceptInt16(VioletWakeEngine *engine, const int16_t *samples,
                              int32_t sample_count, int32_t sample_rate);

void VioletWakeDestroy(VioletWakeEngine *engine);

#endif

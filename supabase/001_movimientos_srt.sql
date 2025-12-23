-- =============================================
-- TABLA: movimientos_srt
-- Vinculada a casos_srt (NO a expedientes)
-- =============================================

CREATE TABLE IF NOT EXISTS movimientos_srt (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  
  -- Referencia al caso_srt (OBLIGATORIA - solo se insertan si hay match)
  caso_srt_id INTEGER NOT NULL REFERENCES casos_srt(id),
  
  -- Datos del expediente SRT en e-Servicios (para referencia)
  srt_expediente_oid INTEGER NOT NULL,
  srt_expediente_nro VARCHAR(20),
  
  -- Datos del movimiento/ingreso
  srt_ingreso_oid INTEGER NOT NULL,
  srt_ingreso_nro VARCHAR(20),
  fecha TIMESTAMP WITH TIME ZONE,
  tipo_codigo INTEGER,
  tipo_descripcion VARCHAR(255),
  
  -- Datos del damnificado (redundante pero útil para queries)
  damnificado_nombre VARCHAR(255),
  
  -- Control
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- Evitar duplicados: mismo caso + mismo ingreso
  UNIQUE(caso_srt_id, srt_ingreso_oid)
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_movimientos_srt_caso_srt_id ON movimientos_srt(caso_srt_id);
CREATE INDEX IF NOT EXISTS idx_movimientos_srt_fecha ON movimientos_srt(fecha DESC);
CREATE INDEX IF NOT EXISTS idx_movimientos_srt_created ON movimientos_srt(created_at DESC);

---
name: etl-run
description: Corre el ETL semanal de un cliente - identifica orquestador, ejecuta scripts en orden, valida resultados y reporta.
user_invocable: true
---

# ETL Run

Ejecuta el pipeline ETL semanal de un cliente. Identifica automaticamente los scripts, los corre en orden, valida los resultados y genera un resumen.

## Arguments
- `$ARGUMENTS`: Nombre del cliente y semana (e.g., "Philips W14", "OPPO W15"). Si no se especifica, preguntar.

## Steps
1. Identificar la carpeta del cliente en el workspace (e.g., `Philips/`, `Oppo/`)
2. Leer el CLAUDE.md del cliente para entender el contexto y la estructura ETL
3. Buscar el orquestador: `run_etl*.bat`, `run_etl*.ps1`, o `run_etl*.py`
4. Si hay multiples scripts, leer el orquestador para determinar el orden de ejecucion
5. Ejecutar cada script en orden, capturando stdout y stderr
6. Validar resultados: verificar que las tablas destino tienen datos nuevos (row count > 0)
7. Si algun script falla, detener la ejecucion y reportar el error con contexto
8. Generar resumen con: scripts ejecutados, filas procesadas, tiempo total, errores encontrados

## Output
Resumen estructurado:

```
ETL [Cliente] [Semana] - Completado
- Scripts ejecutados: N/N
- Filas procesadas: X,XXX
- Tiempo total: MM:SS
- Errores: 0 (o detalle)
- Tablas actualizadas: lista
```

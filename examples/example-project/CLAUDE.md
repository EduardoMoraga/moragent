# Sales Analytics Dashboard

## Overview
Dashboard de analisis de ventas para el equipo comercial. Integra datos de CRM (Pipedrive), ERP y punto de venta para generar reportes semanales de performance por vendedor, producto y region.

## Orchestration
**Model:** Subagents -- el orquestador (este CLAUDE.md) coordina a los agentes especializados.

### Agents
| Agent | Role | Model |
|---|---|---|
| data-analyst | Extrae y transforma datos de las 3 fuentes | sonnet |
| report-writer | Genera reportes HTML con graficos y tablas | sonnet |
| quality-reviewer | Valida datos y verifica calidad del output | opus |

### Skills
| Skill | What it does |
|---|---|
| /etl-run | Corre el pipeline ETL semanal |
| /weekly-report | Genera el reporte semanal de ventas |

## Data Sources
- **Pipedrive API**: deals, actividades, pipeline stages
- **SQL Server**: `my_database.sales.*` -- tablas de ventas historicas
- **CSV uploads**: datos de punto de venta (carga manual semanal)

## Deliverables
- `reports/weekly-sales-W{XX}.html` -- reporte semanal HTML
- `data/processed/sales-consolidated-W{XX}.csv` -- datos consolidados

## Rules
- No publicar datos sin validacion del quality-reviewer
- Siempre comparar con semana anterior (delta %)
- Los reportes deben ser print-friendly (CSS @media print)
- Encoding: UTF-8 con PYTHONUTF8=1 en Windows

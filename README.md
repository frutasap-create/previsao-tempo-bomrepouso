# Previsão Bom Repouso

Sistema diário de apoio à decisão agrícola pra lavoura de morango em Bom Repouso, MG.
Combina 4 modelos meteorológicos fisicamente diferentes (ICON/Alemanha, GFS/EUA, ECMWF/Europa,
Météo-France) via Open-Meteo com dados em tempo real da estação local mais próxima
(wsclima.com.br, ~6km da lavoura). Envia por email todo dia às 5:30 (Brasília):

- Leitura atual da estação local (temperatura, umidade, vento, chuva)
- Risco de geada pra amanhã, com a faixa de incerteza entre os modelos
- Janela sugerida de pulverização nas próximas 48h (vento baixo + sem chuva)
- Previsão de chuva pros próximos 3 dias (mín/média/máx entre os modelos)

## O que ainda NÃO faz (limitações conhecidas)

- Não recalibra os modelos com base no histórico da estação local — cada execução é
  independente, sem "aprender" o viés local ao longo do tempo. Se isso importar, dá pra
  evoluir depois guardando o histórico no Supabase e comparando previsão vs realidade.
- Os limiares de risco de geada (2°C / 5°C) e de janela de pulverização (vento < 15 km/h)
  são estimativas iniciais — ajuste no código conforme a experiência real na lavoura mostrar
  que estão conservadores demais ou de menos.
- Se a API da estação (wsclima.com.br) sair do ar ou mudar de formato, o envio inteiro falha
  (não tem fallback pra rodar só com os modelos). Dá pra adicionar isso depois se for um problema.

## Deploy

1. **GitHub**: criar repositório `previsao-tempo-bomrepouso`, subir os arquivos via
   "Add file → Upload files" — o `api/enviar-previsao.js` precisa ficar dentro da pasta `api/`.

2. **Vercel**: importar o repositório como novo projeto.

3. **Variáveis de ambiente no Vercel**:
   - `RESEND_API_KEY` — pode ser a mesma key já criada pro projeto reflexoes-estoicas
     (o Resend permite usar a mesma key em vários projetos)
   - `RESEND_TO_EMAIL` — o mesmo email já configurado lá

4. **Testar**: abrir a URL do projeto e clicar em "Testar envio agora".

5. **Cron**: já configurado em `vercel.json` pra `30 8 * * *` (UTC) = 5:30 Brasília.

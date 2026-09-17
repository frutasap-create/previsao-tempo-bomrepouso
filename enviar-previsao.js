// Coordenadas da lavoura em Bom Repouso, MG
const LAT = -22.482397;
const LON = -46.161914;

// Estação local mais próxima (wsclima.com.br, id 1254, Cambuí/MG, ~6km da lavoura)
const STATION_URL = "https://api.wsclima.com.br/v1/stations/1254/detail";

// Modelos fisicamente diferentes (não apenas "sites" diferentes que usam o mesmo modelo por baixo)
const MODELS = ["icon_seamless", "gfs_seamless", "ecmwf_ifs025", "meteofrance_seamless"];

function media(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// Temperatura de bulbo úmido (fórmula de Stull, 2011) — usada pra calcular o Delta T de pulverização
function bulboUmido(tempC, umidadePerc) {
  const T = tempC;
  const RH = umidadePerc;
  return (
    T * Math.atan(0.151977 * Math.sqrt(RH + 8.313659)) +
    Math.atan(T + RH) -
    Math.atan(RH - 1.676331) +
    0.00391838 * Math.pow(RH, 1.5) * Math.atan(0.023101 * RH) -
    4.686035
  );
}

function classificarDeltaT(deltaT) {
  if (deltaT < 2) return { status: "❌ Não recomendado", motivo: "Delta T muito baixo — risco de inversão térmica / gotas não evaporam direito" };
  if (deltaT <= 8) return { status: "✅ Ideal", motivo: null };
  if (deltaT <= 10) return { status: "⚠️ Marginal", motivo: "use bicos que gerem gotas maiores" };
  return { status: "❌ Não recomendado", motivo: "Delta T muito alto — risco de evaporação/deriva" };
}

export default async function handler(req, res) {
  try {
    // 1) Previsão multi-modelo do Open-Meteo
    const forecastUrl =
      `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
      `&timezone=America%2FSao_Paulo&forecast_days=3` +
      `&daily=temperature_2m_min,temperature_2m_max,precipitation_sum,precipitation_probability_max,wind_speed_10m_max` +
      `&hourly=temperature_2m,precipitation,wind_speed_10m` +
      `&models=${MODELS.join(",")}`;

    const forecastResp = await fetch(forecastUrl);
    const forecast = await forecastResp.json();

    if (forecast.error) throw new Error(`Open-Meteo: ${forecast.reason}`);

    // 2) Dado da estação local (agora)
    // Alguns provedores bloqueiam chamadas sem cabeçalhos de navegador — simulamos aqui
    const stationResp = await fetch(STATION_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Referer: "https://www.wsclima.com.br/",
        Accept: "application/json",
      },
    });
    const stationData = await stationResp.json();

    if (!stationData || !stationData.curr_data) {
      throw new Error(
        `Estação não retornou dados válidos. Status: ${stationResp.status}. Resposta: ${JSON.stringify(stationData).slice(0, 300)}`
      );
    }

    const curr = stationData.curr_data;

    // Esses 4 já vêm prontos, calculados pela própria API da estação — não recalculamos
    const minimaHoje = stationData.minima;
    const maximaHoje = stationData.maxima;
    const eto = stationData.eto;
    const fwi = stationData.fwi; // risco de incêndio

    // Delta T de pulverização — esse SIM precisamos calcular (não vem pronto na API)
    const tw = bulboUmido(curr.temp, curr.humidity);
    const deltaT = curr.temp - tw;
    const classificacaoDeltaT = classificarDeltaT(deltaT);

    // 3) Analisar risco de geada pra amanhã (índice 1 do array diário = amanhã)
    const idxAmanha = 1;
    const minsAmanha = MODELS.map((m) => forecast.daily[`temperature_2m_min_${m}`][idxAmanha]);
    const minMinAmanha = Math.min(...minsAmanha);
    const maxMinAmanha = Math.max(...minsAmanha);
    const mediaMinAmanha = media(minsAmanha);

    let riscoGeada;
    if (minMinAmanha <= 2) {
      riscoGeada = "🔴 RISCO ALTO de geada esta noite/amanhã de manhã";
    } else if (minMinAmanha <= 5) {
      riscoGeada = "🟡 Atenção — risco moderado de geada, vale monitorar";
    } else {
      riscoGeada = "🟢 Sem risco significativo de geada";
    }

    // 4) Janela de pulverização — próximas 48h, média dos modelos por hora
    const horas = forecast.hourly.time;
    const janelasBoas = [];
    for (let i = 0; i < Math.min(48, horas.length); i++) {
      const ventoHora = media(MODELS.map((m) => forecast.hourly[`wind_speed_10m_${m}`][i]));
      const chuvaHora = media(MODELS.map((m) => forecast.hourly[`precipitation_${m}`][i]));
      // próximas 4h sem chuva relevante, a partir dessa hora
      const proximas4hSemChuva = [0, 1, 2, 3].every((offset) => {
        const idx = i + offset;
        if (idx >= horas.length) return false;
        return media(MODELS.map((m) => forecast.hourly[`precipitation_${m}`][idx])) < 0.3;
      });
      if (ventoHora < 15 && chuvaHora < 0.3 && proximas4hSemChuva) {
        janelasBoas.push(horas[i]);
      }
    }

    // Agrupar horários consecutivos em blocos legíveis (ex: "08:00–11:00")
    function agruparBlocos(lista) {
      if (lista.length === 0) return [];
      const blocos = [];
      let inicio = lista[0];
      let anterior = lista[0];
      for (let i = 1; i < lista.length; i++) {
        const atual = new Date(lista[i]);
        const prev = new Date(anterior);
        if ((atual - prev) / 3600000 > 1) {
          blocos.push([inicio, anterior]);
          inicio = lista[i];
        }
        anterior = lista[i];
      }
      blocos.push([inicio, anterior]);
      return blocos;
    }

    function formatarHora(iso) {
      const d = new Date(iso);
      return d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "short", hour: "2-digit", minute: "2-digit" });
    }

    const blocosPulverizacao = agruparBlocos(janelasBoas)
      .map(([ini, fim]) => `${formatarHora(ini)} até ${formatarHora(fim)}`)
      .slice(0, 4);

    // 5) Chuva prevista próximos 3 dias (spread entre modelos)
    const diasChuva = forecast.daily.time.map((data, i) => {
      const valores = MODELS.map((m) => forecast.daily[`precipitation_sum_${m}`][i]);
      return {
        data,
        min: Math.min(...valores).toFixed(1),
        media: media(valores).toFixed(1),
        max: Math.max(...valores).toFixed(1),
      };
    });

    // 6) Montar o email
    const dataGeracao = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

    const html = `
      <h2>🌤️ Boletim do dia — Lavoura Bom Repouso</h2>
      <p style="color:#666;font-size:13px;">Gerado em ${dataGeracao} (horário de Brasília)</p>

      <h3>📍 Estação local agora (Cambuí, ~6km da lavoura)</h3>
      <ul>
        <li>Temperatura: <b>${curr.temp}°C</b> (mín hoje: ${minimaHoje}°C / máx hoje: ${maximaHoje}°C)</li>
        <li>Umidade: ${curr.humidity}%</li>
        <li>Vento: ${curr.wind_speed} km/h (rajada: ${curr.wind_gust} km/h)</li>
        <li>Chuva acumulada hoje: ${curr.precip_total} mm</li>
        <li>Ponto de orvalho: ${curr.dew_point}°C</li>
        <li>Evapotranspiração (ETo): ${eto.toFixed(2)} mm</li>
        <li>Risco de incêndio: ${fwi.level}</li>
      </ul>

      <h3>💧 Pulverização agora (Delta T)</h3>
      <p><b>${classificacaoDeltaT.status}</b> — Delta T atual: ${deltaT.toFixed(1)}°C
        ${classificacaoDeltaT.motivo ? `(${classificacaoDeltaT.motivo})` : ""}</p>
      <p style="font-size:13px;color:#666;">
        Delta T é a diferença entre a temperatura do ar e a temperatura de bulbo úmido — calculado
        a partir da leitura atual da estação (temperatura + umidade). Ideal entre 2°C e 8°C.
      </p>

      <h3>❄️ Risco de geada (amanhã)</h3>
      <p><b>${riscoGeada}</b></p>
      <p style="font-size:13px;color:#666;">
        Mínima prevista pelos ${MODELS.length} modelos: entre ${minMinAmanha.toFixed(1)}°C e ${maxMinAmanha.toFixed(1)}°C
        (média: ${mediaMinAmanha.toFixed(1)}°C). Quanto maior a diferença entre os modelos, maior a incerteza.
      </p>

      <h3>💨 Janela de pulverização (próximas 48h)</h3>
      ${
        blocosPulverizacao.length > 0
          ? `<ul>${blocosPulverizacao.map((b) => `<li>${b}</li>`).join("")}</ul>`
          : "<p>Nenhuma janela clara identificada (vento ou chuva atrapalhando nas próximas 48h).</p>"
      }
      <p style="font-size:13px;color:#666;">Critério: vento médio abaixo de 15 km/h e sem chuva prevista nas 4h seguintes.</p>

      <h3>🌧️ Chuva prevista (próximos 3 dias)</h3>
      <table style="border-collapse:collapse;">
        <tr style="text-align:left;border-bottom:1px solid #ccc;">
          <th style="padding:4px 12px 4px 0;">Dia</th>
          <th style="padding:4px 12px;">Mín (mm)</th>
          <th style="padding:4px 12px;">Média (mm)</th>
          <th style="padding:4px 12px;">Máx (mm)</th>
        </tr>
        ${diasChuva
          .map(
            (d) =>
              `<tr><td style="padding:4px 12px 4px 0;">${d.data}</td><td style="padding:4px 12px;">${d.min}</td><td style="padding:4px 12px;">${d.media}</td><td style="padding:4px 12px;">${d.max}</td></tr>`
          )
          .join("")}
      </table>

      <p style="font-size:12px;color:#999;margin-top:20px;">
        Fontes: Open-Meteo (modelos ${MODELS.join(", ")}) + estação local wsclima.com.br/estacao/1254.
        Este é um sistema experimental — use como apoio à decisão, não como única fonte.
      </p>
    `;

    const textoSimples = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    const RESEND_TO_EMAIL = process.env.RESEND_TO_EMAIL;

    const envioResp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Previsão Bom Repouso <onboarding@resend.dev>",
        to: [RESEND_TO_EMAIL],
        subject: `🌤️ Boletim do dia — ${riscoGeada.includes("ALTO") ? "⚠️ Risco de geada" : "Bom Repouso"}`,
        text: textoSimples,
        html,
      }),
    });
    const envioJson = await envioResp.json();

    return res.status(200).json({
      ok: true,
      riscoGeada,
      estacaoAgora: { ...curr, minimaHoje, maximaHoje, eto, fwi },
      deltaT: deltaT.toFixed(1),
      classificacaoDeltaT,
      janelasPulverizacao: blocosPulverizacao,
      chuvaPrevisao: diasChuva,
      resend: envioJson,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

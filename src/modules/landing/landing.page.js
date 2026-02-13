function renderLandingPage() {
  return `
<!doctype html>
<html lang="fr">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>RunDNA</title>
    <style>
      :root {
        --bg: #f7efe9;
        --panel: #ffffff;
        --text: #3d1f14;
        --muted: #7f6a60;
        --accent: #f26a33;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: linear-gradient(180deg, var(--bg), #f3e5db);
        color: var(--text);
      }
      .wrap {
        max-width: 880px;
        margin: 0 auto;
        min-height: 100vh;
        padding: 28px 20px 40px;
        display: grid;
        gap: 20px;
        align-content: center;
      }
      .card {
        background: var(--panel);
        border-radius: 24px;
        padding: 28px;
        box-shadow: 0 10px 30px rgba(61, 31, 20, 0.08);
      }
      h1 {
        margin: 0 0 10px;
        font-size: clamp(30px, 6vw, 48px);
      }
      p {
        margin: 0;
        color: var(--muted);
        font-size: 18px;
        line-height: 1.5;
      }
      .grid {
        display: grid;
        gap: 16px;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      }
      .cta {
        display: inline-block;
        margin-top: 14px;
        background: var(--accent);
        color: #fff;
        text-decoration: none;
        border-radius: 999px;
        padding: 12px 18px;
        font-weight: 700;
      }
      .qr {
        width: 180px;
        height: 180px;
        border-radius: 16px;
        border: 8px solid #fff;
        background:
          linear-gradient(45deg, #111 25%, transparent 25%) 0 0/20px 20px,
          linear-gradient(-45deg, #111 25%, transparent 25%) 0 10px/20px 20px,
          linear-gradient(45deg, transparent 75%, #111 75%) 10px -10px/20px 20px,
          linear-gradient(-45deg, transparent 75%, #111 75%) -10px 0/20px 20px;
      }
      .hint {
        font-size: 14px;
        margin-top: 10px;
      }
    </style>
  </head>
  <body>
    <main class="wrap">
      <section class="card">
        <h1>RunDNA</h1>
        <p>Ton shadow coach CAP/trail arrive sur iOS et Android.</p>
        <a class="cta" href="#stores">Telecharger bientot</a>
      </section>

      <section id="stores" class="grid">
        <article class="card">
          <h2>App Store</h2>
          <p>Lien en cours de preparation.</p>
          <p class="hint">Bouton factice pour le MVP backend.</p>
        </article>
        <article class="card">
          <h2>Google Play</h2>
          <p>Lien en cours de preparation.</p>
          <p class="hint">Bouton factice pour le MVP backend.</p>
        </article>
        <article class="card">
          <h2>QR code</h2>
          <div class="qr" aria-label="QR code factice"></div>
          <p class="hint">QR temporaire, remplace par un vrai URL plus tard.</p>
        </article>
      </section>
    </main>
  </body>
</html>
`;
}

module.exports = { renderLandingPage };

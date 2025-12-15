export default async function handler(req, res) {
  try {
    // 疎通確認（ブラウザ直アクセス用）
    if (req.method === 'GET') {
      return res.status(200).send('OK');
    }

    // LINE Webhook（POST）
    if (req.method === 'POST') {
      console.log('Webhook received');

      return res.status(200).json({
        status: 'received'
      });
    }

    return res.status(405).send('Method Not Allowed');

  } catch (err) {
    console.error('ERROR:', err);
    return res.status(500).json({
      error: err.message
    });
  }
}

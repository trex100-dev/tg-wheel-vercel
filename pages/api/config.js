module.exports = async function handler(req, res) {
  res.status(200).json({ spinPrice: parseInt(process.env.SPIN_PRICE || '1', 10) || 1 });
};
const { sql, getPool } = require("../config/db");

// Calculate late fine dynamically for a voucher
const calculateVoucherFine = (voucher, finePerDay = 100) => {
  if (voucher.VoucherStatus === "Paid" || voucher.VoucherStatus === "Cancelled") {
    return {
      daysLate: 0,
      fineAmount: Number(voucher.FineAmount) || 0,
      totalAmount: Number(voucher.BaseAmount) + (Number(voucher.FineAmount) || 0),
      isOverdue: false,
    };
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const dueDate = new Date(voucher.DueDate);
  dueDate.setHours(0, 0, 0, 0);

  let daysLate = 0;
  let fineAmount = 0;
  let isOverdue = false;

  if (today > dueDate) {
    const diffTime = Math.abs(today - dueDate);
    daysLate = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    fineAmount = daysLate * finePerDay;
    isOverdue = true;
  }

  return {
    daysLate,
    fineAmount,
    totalAmount: Number(voucher.BaseAmount) + fineAmount,
    isOverdue,
  };
};

// Fetch current late fine per day from ClubSettings
const getFineSetting = async () => {
  try {
    const pool = getPool();
    const result = await pool.request()
      .input("Key", sql.NVarChar(50), "LateFinePerDay")
      .query("SELECT SettingValue FROM ClubSettings WHERE SettingKey = @Key");

    if (result.recordset.length > 0) {
      return Number(result.recordset[0].SettingValue) || 100;
    }
  } catch (err) {
    console.error("Error reading fine setting:", err.message);
  }
  return 100;
};

// Fetch default due day (e.g. 10th) from ClubSettings
const getDefaultDueDay = async () => {
  try {
    const pool = getPool();
    const result = await pool.request()
      .input("Key", sql.NVarChar(50), "DefaultDueDay")
      .query("SELECT SettingValue FROM ClubSettings WHERE SettingKey = @Key");

    if (result.recordset.length > 0) {
      return Number(result.recordset[0].SettingValue) || 10;
    }
  } catch (err) {
    console.error("Error reading due day setting:", err.message);
  }
  return 10;
};

module.exports = { calculateVoucherFine, getFineSetting, getDefaultDueDay };

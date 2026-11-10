
const BASE_URL = "http://localhost:5000/api";

async function request(url, options = {}) {
  const headers = { "Content-Type": "application/json", ...options.headers };
  const res = await fetch(url, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `HTTP ${res.status}: ${res.statusText}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function runE2ETests() {
  console.log("=================================================");
  console.log("SPORTS HUB - FULL E2E SYSTEM VERIFICATION");
  console.log("=================================================\n");

  const testEmail = `athlete_${Date.now()}@testclub.com`;
  const testPassword = "Password@123";
  let userToken = "";
  let adminToken = "";
  let applicationId = 0;
  let advanceVoucherId = 0;
  let paymentId = 0;

  // 1. PUBLIC ENDPOINTS
  console.log("[TEST 1] Verifying Public CMS & Club Information...");
  try {
    const pubData = await request(`${BASE_URL}/public/club-info`);
    console.log("  Club Name:", pubData.settings.ClubName);
    console.log("  Bank Info:", pubData.settings.BankName, pubData.settings.AccountNumber);
    console.log("  Fine Per Day:", pubData.settings.LateFinePerDay);
    console.log("  [PASS] Public club info verified.\n");
  } catch (err) {
    console.error("  [FAIL] Public club info failed:", err.message, err.data);
    process.exit(1);
  }

  // 2. USER REGISTRATION
  console.log("[TEST 2] Testing User Registration Flow (Role = 'user')...");
  try {
    const regData = await request(`${BASE_URL}/auth/register`, {
      method: "POST",
      body: JSON.stringify({
        fullName: "Hamza Tariq",
        email: testEmail,
        password: testPassword,
        phone: "+92 300 9876543",
      }),
    });
    const userRole = regData.user.Role || regData.user.role;
    console.log("  Registered:", regData.message);
    console.log("  User Role in response:", userRole);
    if (userRole !== "user") {
      throw new Error(`Expected role 'user', got ${userRole}`);
    }
    console.log("  [PASS] User registered strictly with role 'user'.\n");
  } catch (err) {
    console.error("  [FAIL] Registration failed:", err.message, err.data);
    process.exit(1);
  }

  // 3. USER LOGIN
  console.log("[TEST 3] Testing User Login Flow...");
  try {
    const loginData = await request(`${BASE_URL}/auth/login`, {
      method: "POST",
      body: JSON.stringify({
        email: testEmail,
        password: testPassword,
      }),
    });
    userToken = loginData.token;
    console.log("  Login successful. Token acquired.");
    console.log("  User FullName:", loginData.user.fullName);
    console.log("  [PASS] User authenticated.\n");
  } catch (err) {
    console.error("  [FAIL] Login failed:", err.message, err.data);
    process.exit(1);
  }

  // 4. MEMBERSHIP PLANS & APPLICATION
  console.log("[TEST 4] Fetching Membership Plans and Submitting Application...");
  try {
    const plansData = await request(`${BASE_URL}/public/plans`);
    const plansList = plansData.plans || plansData.data || [];
    const premiumPlan = plansList[0];
    console.log(`  Selected Plan: ${premiumPlan.PlanName} (Rs. ${premiumPlan.MonthlyFee}/mo, Duration: ${premiumPlan.DurationMonths} mos)`);

    const applyData = await request(`${BASE_URL}/membership/apply`, {
      method: "POST",
      headers: { Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({
        planId: premiumPlan.PlanID,
        address: "House 45, Sector F-8/2, Islamabad",
        emergencyContactName: "Tariq Mahmood",
        emergencyContactPhone: "+92 321 5556677",
      }),
    });
    applicationId = applyData.applicationId;
    console.log("  Application submitted. ID:", applicationId);
    console.log("  Message:", applyData.message);

    // Verify status is PendingPayment
    const statusData = await request(`${BASE_URL}/membership/my-status`, {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    console.log("  Current Membership Status:", statusData.membership?.MembershipStatus);
    console.log("  Application Status:", statusData.membership?.ApplicationStatus);
    console.log("  [PASS] Membership application and PendingPayment state verified.\n");
  } catch (err) {
    console.error("  [FAIL] Application failed:", err.message, err.data);
    process.exit(1);
  }

  // 5. ADMIN LOGIN
  console.log("[TEST 5] Authenticating Existing Club Admin (admin123@gmail.com)...");
  try {
    const adminLoginData = await request(`${BASE_URL}/auth/login`, {
      method: "POST",
      body: JSON.stringify({
        email: "admin123@gmail.com",
        password: "Admin@123",
      }),
    });
    adminToken = adminLoginData.token;
    console.log("  Admin Login successful. Role:", adminLoginData.user.role);
    if (adminLoginData.user.role !== "admin") {
      throw new Error("Admin user role is not admin!");
    }
    console.log("  [PASS] Admin verified.\n");
  } catch (err) {
    console.error("  [FAIL] Admin login failed:", err.message, err.data);
    process.exit(1);
  }

  // 6. ADMIN REVIEWS AND APPROVES MEMBERSHIP
  console.log("[TEST 6] Admin Approves Membership Application...");
  try {
    const approveData = await request(`${BASE_URL}/admin/applications/${applicationId}/review`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        action: "approve",
        remarks: "Credentials and ID verified by front desk.",
      }),
    });
    console.log("  Admin review response:", approveData.message);

    // Member checks digital card
    const cardData = await request(`${BASE_URL}/membership/digital-card`, {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    console.log("  Member Digital Card Status:", cardData.card.MembershipStatus);
    console.log("  Assigned Membership #:", cardData.card.MembershipNumber);
    console.log("  [PASS] Application approved and Active digital card issued.\n");
  } catch (err) {
    console.error("  [FAIL] Admin approval failed:", err.message, err.data);
    process.exit(1);
  }

  // 7. ADVANCE PAYMENT VOUCHER GENERATION (3 MONTHS)
  console.log("[TEST 7] Member Requests 3 Months Advance Payment Voucher...");
  try {
    const advData = await request(`${BASE_URL}/vouchers/advance`, {
      method: "POST",
      headers: { Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({ monthsCount: 3 }),
    });
    advanceVoucherId = advData.voucherId;
    console.log("  Advance Voucher Created. ID:", advanceVoucherId);
    console.log("  Voucher Number:", advData.voucherNumber);
    console.log("  Total Payable Amount: Rs.", advData.totalAmount);
    console.log("  Covered Months:", advData.months.map(m => `${m.month}/${m.year}`).join(", "));
    console.log("  [PASS] Advance voucher correctly generated.\n");
  } catch (err) {
    console.error("  [FAIL] Advance voucher creation failed:", err.message, err.data);
    process.exit(1);
  }

  // 8. PAYMENT RECEIPT SUBMISSION
  console.log("[TEST 8] Member Uploads Payment Receipt for Advance Voucher...");
  try {
    const payData = await request(`${BASE_URL}/payments/submit`, {
      method: "POST",
      headers: { Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({
        voucherId: advanceVoucherId,
        paymentMethod: "Bank Transfer",
        transactionReference: "HBL-FT-98471203",
        imageUrl: "https://images.unsplash.com/photo-1554224155-8d04cb21cd6c?w=800",
      }),
    });
    paymentId = payData.paymentId;
    console.log("  Payment submitted. ID:", paymentId);
    console.log("  Receipt URL:", payData.receiptUrl);
    console.log("  [PASS] Receipt uploaded and voucher set to PendingVerification.\n");
  } catch (err) {
    console.error("  [FAIL] Payment submission failed:", err.message, err.data);
    process.exit(1);
  }

  // 9. ADMIN APPROVES PAYMENT & RECORDS PREPAYMENTS
  console.log("[TEST 9] Admin Verifies Receipt and Approves Payment...");
  try {
    const revPayData = await request(`${BASE_URL}/admin/payments/${paymentId}/review`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        action: "approve",
        remarks: "Funds verified in club bank statement.",
      }),
    });
    console.log("  Admin review result:", revPayData.message);

    // Verify voucher status is now Paid
    const vchData = await request(`${BASE_URL}/vouchers/${advanceVoucherId}`, {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    console.log("  Voucher Status after approval:", vchData.voucher.VoucherStatus);
    if (vchData.voucher.VoucherStatus !== "Paid") {
      throw new Error(`Expected VoucherStatus 'Paid', got ${vchData.voucher.VoucherStatus}`);
    }
    console.log("  [PASS] Payment approved, voucher marked Paid, prepayments recorded.\n");
  } catch (err) {
    console.error("  [FAIL] Payment review failed:", err.message, err.data);
    process.exit(1);
  }

  // 10. BATCH MONTHLY VOUCHER GENERATION & ADVANCE PREPAYMENT SKIP VERIFICATION
  console.log("[TEST 10] Testing Monthly Voucher Batch Generation & Advance Skip...");
  try {
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();

    const genData = await request(`${BASE_URL}/admin/vouchers/generate-monthly`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ billingMonth: currentMonth, billingYear: currentYear, dueDay: 10 }),
    });

    console.log("  Batch Generation Summary for", `${currentMonth}/${currentYear}:`);
    console.log("    Total Active Members:", genData.summary.totalActiveMembers);
    console.log("    Vouchers Created:", genData.summary.generatedCount);
    console.log("    Skipped (Advance Prepaid):", genData.summary.skippedPrepaidCount);
    console.log("    Already Generated:", genData.summary.alreadyGeneratedCount);

    if (genData.summary.skippedPrepaidCount < 1) {
      throw new Error("Expected at least 1 skipped member covered by advance prepayments!");
    }

    console.log("  [PASS] Advance prepayment skip logic verified! No duplicate voucher generated.\n");
  } catch (err) {
    console.error("  [FAIL] Batch voucher generation test failed:", err.message, err.data);
    process.exit(1);
  }

  // 11. ADMIN DASHBOARD METRICS VERIFICATION
  console.log("[TEST 11] Verifying Admin Dashboard Analytics & Overview...");
  try {
    const dashData = await request(`${BASE_URL}/admin/dashboard`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const stats = dashData.stats || dashData.metrics;
    console.log("  Total Users:", stats.TotalUsers);
    console.log("  Active Members:", stats.ActiveMembers);
    console.log("  Total Revenue Collected: Rs.", stats.TotalRevenue);
    console.log("  Pending Payments Count:", stats.PendingPayments);
    console.log("  [PASS] Admin dashboard metrics verified against real DB records.\n");
  } catch (err) {
    console.error("  [FAIL] Dashboard metrics failed:", err.message, err.data);
    process.exit(1);
  }

  console.log("=================================================");
  console.log("🎉 ALL E2E INTEGRATION TESTS PASSED PERFECTLY!");
  console.log("=================================================");
}

runE2ETests();

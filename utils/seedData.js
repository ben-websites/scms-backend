const { sql, getPool } = require("../config/db");
const bcrypt = require("bcrypt");
const { initSportsModules } = require("./initSportsModules");

const seedInitialData = async () => {
  try {
    const pool = getPool();

    // The sports catalogue / coaches / equipment seed is only meaningful on an
    // empty database. Skipping it on a populated (migrated) database keeps
    // serverless cold starts to a couple of cheap queries.
    const sportsCheck = await pool.request().query("SELECT COUNT(*) AS count FROM Sports");
    if (Number(sportsCheck.recordset[0].count) === 0) {
      await initSportsModules();
    }

    // 1. Default club settings (ClubSettings lives in db/schema.sql)
    const defaultSettings = [
      { key: "LateFinePerDay", value: "100", desc: "Late payment penalty fine in PKR per day overdue" },
      { key: "DefaultDueDay", value: "10", desc: "Default monthly due day (1 to 28)" },
      { key: "ClubName", value: "Sports Hub", desc: "Official name of the sports club" },
      { key: "ClubPhone", value: "+92 300 1234567", desc: "Contact phone number" },
      { key: "ClubEmail", value: "info@sportshub.com", desc: "Contact email" },
      { key: "BankName", value: "Habib Bank Limited (HBL)", desc: "Club bank account name" },
      { key: "AccountNumber", value: "0123-45678901-03", desc: "Bank account number for fee deposits" },
      { key: "AccountTitle", value: "Sports Hub Management", desc: "Account title" }
    ];

    for (const s of defaultSettings) {
      await pool.request()
        .input("Key", sql.NVarChar(50), s.key)
        .input("Value", sql.NVarChar(255), s.value)
        .input("Desc", sql.NVarChar(255), s.desc)
        .query(`
          INSERT INTO ClubSettings (SettingKey, SettingValue, Description)
          VALUES (@Key, @Value, @Desc)
          ON CONFLICT (SettingKey) DO NOTHING
        `);
    }

    // 2. Seed MembershipPlans if empty
    const plansCount = await pool.request().query("SELECT COUNT(*) AS count FROM MembershipPlans");
    if (Number(plansCount.recordset[0].count) === 0) {
      console.log("Seeding initial MembershipPlans...");
      const plans = [
        {
          name: "Bronze Starter",
          desc: "Entry-level fitness package with access to main gymnasium, outdoor jogging track, and standard locker facilities.",
          fee: 2000,
          months: 3
        },
        {
          name: "Silver Active",
          desc: "Ideal for sports enthusiasts. Full gym access, indoor badminton courts, Olympic swimming pool, and sauna access.",
          fee: 3500,
          months: 6
        },
        {
          name: "Gold Champion",
          desc: "Comprehensive club package including all sports courts, floodlit tennis access, sauna/spa, and priority court bookings.",
          fee: 5000,
          months: 12
        },
        {
          name: "Platinum Elite VIP",
          desc: "All-inclusive VIP membership with dedicated fitness trainer, squash & tennis courts, tournament entry, guest privileges & club lounge.",
          fee: 8500,
          months: 12
        }
      ];

      for (const p of plans) {
        await pool.request()
          .input("PlanName", sql.NVarChar(100), p.name)
          .input("Description", sql.NVarChar(sql.MAX), p.desc)
          .input("MonthlyFee", sql.Decimal(10, 2), p.fee)
          .input("DurationMonths", sql.Int, p.months)
          .query(`
            INSERT INTO MembershipPlans (PlanName, Description, MonthlyFee, DurationMonths, IsActive, CreatedAt)
            VALUES (@PlanName, @Description, @MonthlyFee, @DurationMonths, 1, SYSDATETIME())
          `);
      }
    }

    // 3. Seed Sports if empty (full catalogue is handled by initSportsModules)
    const sportsCountCheck = await pool.request().query("SELECT COUNT(*) AS count FROM Sports");
    if (Number(sportsCountCheck.recordset[0].count) === 0) {
      console.log("Seeding initial Sports facilities...");
      const sports = [
        {
          name: "Cricket Pavilion & Nets",
          desc: "International grade turf pitch, state-of-the-art practice bowling nets with automated speed guns, and seasonal club leagues.",
          image: "https://images.unsplash.com/photo-1540747913346-19e32dc3e97e?auto=format&fit=crop&w=1200&q=80"
        },
        {
          name: "Olympic Swimming Complex",
          desc: "50-meter temperature-controlled Olympic swimming pool, diving boards, dedicated kids splash pool, and certified lifesavers.",
          image: "https://images.unsplash.com/photo-1576610616656-d3aa5d1f4534?auto=format&fit=crop&w=1200&q=80"
        },
        {
          name: "Lawn & Synthetic Tennis Courts",
          desc: "4 professional synthetic hard courts equipped with high-intensity LED floodlights and automated ball return machines.",
          image: "https://images.unsplash.com/photo-1622279457486-62dcc4a431d6?auto=format&fit=crop&w=1200&q=80"
        },
        {
          name: "Indoor Badminton Arena",
          desc: "4 professional BWF-standard wooden parquet courts with anti-glare overhead illumination and climate control.",
          image: "https://images.unsplash.com/photo-1626224583764-f87db24ac4ea?auto=format&fit=crop&w=1200&q=80"
        },
        {
          name: "High-Performance Gym & Fitness",
          desc: "Over 8,000 sq.ft of cardio machines, Olympic power racks, calibrated plates, functional CrossFit zone, and free weights.",
          image: "https://images.unsplash.com/photo-1534438327276-14e5300c3a48?auto=format&fit=crop&w=1200&q=80"
        },
        {
          name: "Glass-Back Squash Courts",
          desc: "ASB regulation glass-backed competition squash courts featuring air conditioning and spectator viewing gallery.",
          image: "https://images.unsplash.com/photo-1554068865-24cecd4e34b8?auto=format&fit=crop&w=1200&q=80"
        }
      ];

      for (const sp of sports) {
        await pool.request()
          .input("SportName", sql.NVarChar(100), sp.name)
          .input("Description", sql.NVarChar(sql.MAX), sp.desc)
          .input("ImageURL", sql.NVarChar(500), sp.image)
          .query(`
            INSERT INTO Sports (SportName, Description, ImageURL, IsActive, CreatedAt)
            VALUES (@SportName, @Description, @ImageURL, 1, SYSDATETIME())
          `);
      }
    }

    // 4. Seed Services if empty
    const servicesCount = await pool.request().query("SELECT COUNT(*) AS count FROM Services");
    if (Number(servicesCount.recordset[0].count) === 0) {
      console.log("Seeding initial Club Services...");
      const services = [
        {
          name: "Personal Fitness Coaching",
          desc: "Certified athletic trainers delivering personalized nutrition regimens, biometric tracking, and targeted muscle conditioning.",
          image: "https://images.unsplash.com/photo-1571019613454-1cb2f99b2d8b?auto=format&fit=crop&w=1200&q=80"
        },
        {
          name: "Junior & Adult Sports Academies",
          desc: "Professional coaching clinics in cricket, tennis, swimming, and badminton led by former national athletes.",
          image: "https://images.unsplash.com/photo-1526676037777-05a232554f77?auto=format&fit=crop&w=1200&q=80"
        },
        {
          name: "Executive Steam, Sauna & Recovery",
          desc: "Therapeutic infrared saunas, eucalyptus steam baths, cold plunge recovery tubs, and sports massage therapy rooms.",
          image: "https://images.unsplash.com/photo-1540555700478-4be289fbecef?auto=format&fit=crop&w=1200&q=80"
        },
        {
          name: "High-Protein Member Cafeteria & Lounge",
          desc: "Chef-prepared nutrition bowls, organic fruit smoothies, whey protein shakes, and a comfortable member co-working lounge.",
          image: "https://images.unsplash.com/photo-1559925393-8be0ec4767c8?auto=format&fit=crop&w=1200&q=80"
        }
      ];

      for (const sv of services) {
        await pool.request()
          .input("ServiceName", sql.NVarChar(100), sv.name)
          .input("Description", sql.NVarChar(sql.MAX), sv.desc)
          .input("ImageURL", sql.NVarChar(500), sv.image)
          .query(`
            INSERT INTO Services (ServiceName, Description, ImageURL, IsActive, CreatedAt)
            VALUES (@ServiceName, @Description, @ImageURL, 1, SYSDATETIME())
          `);
      }
    }

    // 5. Seed Announcements if empty
    const annCheck = await pool.request().query("SELECT COUNT(*) AS count FROM Announcements");
    const adminUser = await pool.request().query("SELECT TOP 1 UserID FROM Users WHERE Role = 'admin'");
    const adminId = adminUser.recordset.length > 0 ? adminUser.recordset[0].UserID : 2;

    if (Number(annCheck.recordset[0].count) === 0 && adminId) {
      console.log("Seeding initial Announcements...");
      const announcements = [
        {
          title: "Annual Sports Gala & Registration Now Open",
          message: "Welcome to Sports Hub! Registration is officially open for the upcoming season. All registered members can enroll in club tournaments.",
          audience: "All"
        },
        {
          title: "Monthly Fee Due Date & Advance Discount Policy",
          message: "Monthly vouchers for active members are due on the 10th of every month. Members wishing to pay 3+ months in advance can submit advance requests via their dashboard.",
          audience: "Members"
        }
      ];

      for (const a of announcements) {
        await pool.request()
          .input("Title", sql.NVarChar(200), a.title)
          .input("Message", sql.NVarChar(sql.MAX), a.message)
          .input("Audience", sql.NVarChar(50), a.audience)
          .input("CreatedBy", sql.Int, adminId)
          .query(`
            INSERT INTO Announcements (Title, Message, Audience, IsPublished, PublishedAt, CreatedBy, CreatedAt)
            VALUES (@Title, @Message, @Audience, 1, SYSDATETIME(), @CreatedBy, SYSDATETIME())
          `);
      }
    }

    // 6. Seed Events if empty
    const eventCheck = await pool.request().query("SELECT COUNT(*) AS count FROM Events");
    if (Number(eventCheck.recordset[0].count) === 0 && adminId) {
      console.log("Seeding initial Events...");
      const events = [
        {
          name: "Inter-Club Summer Tennis Open",
          desc: "Men's & Women's Singles and Doubles Championship. Trophies, medals, and gear vouchers for winners.",
          image: "https://images.unsplash.com/photo-1622279457486-62dcc4a431d6?auto=format&fit=crop&w=1200&q=80",
          date: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000), // in 14 days
          venue: "Main Tennis Courts 1 & 2",
          maxParticipants: 32
        },
        {
          name: "50m Freestyle Swimming Gala",
          desc: "Timed swimming heats across age divisions with certified timekeepers and electronic touchpads.",
          image: "https://images.unsplash.com/photo-1576610616656-d3aa5d1f4534?auto=format&fit=crop&w=1200&q=80",
          date: new Date(Date.now() + 21 * 24 * 60 * 60 * 1000), // in 21 days
          venue: "Olympic Swimming Complex",
          maxParticipants: 48
        },
        {
          name: "Club Badminton Masters Tournament",
          desc: "Fast-paced knockout tournament featuring indoor wood parquet courts and professional refereeing.",
          image: "https://images.unsplash.com/photo-1626224583764-f87db24ac4ea?auto=format&fit=crop&w=1200&q=80",
          date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // in 30 days
          venue: "Indoor Badminton Hall",
          maxParticipants: 64
        }
      ];

      for (const ev of events) {
        await pool.request()
          .input("EventName", sql.NVarChar(150), ev.name)
          .input("Description", sql.NVarChar(sql.MAX), ev.desc)
          .input("EventImageURL", sql.NVarChar(500), ev.image)
          .input("EventDate", sql.DateTime2, ev.date)
          .input("RegistrationDeadline", sql.DateTime2, new Date(ev.date.getTime() - 2 * 24 * 60 * 60 * 1000))
          .input("Venue", sql.NVarChar(150), ev.venue)
          .input("MaxPart", sql.Int, ev.maxParticipants)
          .input("CreatedBy", sql.Int, adminId)
          .query(`
            INSERT INTO Events (EventName, Description, EventImageURL, EventDate, RegistrationDeadline, Venue, MaximumParticipants, EventStatus, CreatedBy, CreatedAt)
            VALUES (@EventName, @Description, @EventImageURL, @EventDate, @RegistrationDeadline, @Venue, @MaxPart, 'Upcoming', @CreatedBy, SYSDATETIME())
          `);
      }
    }

    // 7. Seed Initial System Notifications if empty
    const notifCheck = await pool.request().query("SELECT COUNT(*) AS count FROM Notifications");
    if (Number(notifCheck.recordset[0].count) === 0) {
      console.log("Seeding initial System Notifications...");
      const initialNotifs = [
        {
          role: "admin",
          title: "System Online & Synchronized 🚀",
          message: "Sports Hub Management System core engine is operational. 11 modules and real-time activity channels connected.",
          type: "system",
          link: "/admin/dashboard",
        },
        {
          role: "admin",
          title: "Monthly Ledger Ready",
          message: "Billing generation engine initialized. You can generate monthly fee vouchers under Monthly Fees module.",
          type: "voucher",
          link: "/admin/vouchers",
        },
        {
          role: "user",
          title: "Welcome to Sports Hub! 🏆",
          message: "Welcome to your member portal! Submit your membership application to unlock court bookings, gym access, and tournaments.",
          type: "membership",
          link: "/user/membership",
        },
        {
          role: "user",
          title: "Upcoming Sports Leagues 🏅",
          message: "Summer Tennis Open and Badminton Masters are scheduled. View details and enroll under Events & Leagues.",
          type: "event",
          link: "/user/events",
        },
      ];

      for (const n of initialNotifs) {
        await pool.request()
          .input("Role", sql.NVarChar(20), n.role)
          .input("Title", sql.NVarChar(255), n.title)
          .input("Message", sql.NVarChar(sql.MAX), n.message)
          .input("Type", sql.NVarChar(50), n.type)
          .input("Link", sql.NVarChar(255), n.link)
          .query(`
            INSERT INTO Notifications (UserID, Role, Title, Message, Type, Link, IsRead, CreatedAt)
            VALUES (NULL, @Role, @Title, @Message, @Type, @Link, 0, SYSDATETIME())
          `);
      }
    }

    console.log("Database seed check completed successfully.");
  } catch (error) {
    console.error("Database seed error:", error);
  }
};

module.exports = { seedInitialData };

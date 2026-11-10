const { sql, getPool } = require("../config/db");
const { ensureStaffModules } = require("./initStaffModules");

const initSportsModules = async () => {
  const pool = getPool();

  try {
    // All tables, columns, constraints and indexes are defined in
    // db/schema.sql (generated from the original SQL Server database).
    // This module only seeds the sports catalogue.

    // Now seed the 20 sports!
    await seed20SportsAndCoaches(pool);

    // Finally make sure the coaching hierarchy (accounts, trainers, staff
    // attendance, salaries and approval workflow) is in place.
    await ensureStaffModules();

  } catch (error) {
    console.error("Error initializing sports modules:", error);
  }
};

const seed20SportsAndCoaches = async (pool) => {
  const sportsList = [
    {
      name: "Cricket Pavilion & Nets",
      desc: "ICC standard turf wicket, 6 automated bowling nets, speed radar guns, and seasonal premier league.",
      image: "https://images.unsplash.com/photo-1540747913346-19e32dc3e97e?auto=format&fit=crop&w=1200&q=80",
      coachName: "Rashid Latif",
      coachSpecialty: "Head Cricket Coach & Batting Specialist",
      coachBio: "Former national player with 15+ years coaching experience in first-class and youth cricket academies.",
      coachImage: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=500&q=80",
      venue: "Main Cricket Stadium & Practice Nets",
      category: "Outdoor Team Sport",
      schedule: { title: "Cricket Academy & Net Practice", days: "Mon, Wed, Fri", start: "04:00 PM", end: "07:00 PM" },
      equipments: [
        { item: "SG English Willow Bats", cat: "Bats & Racquets", total: 15, avail: 12, cond: "Good", loc: "Cricket Pavillion Locker A" },
        { item: "Kookaburra Red Turf Leather Balls", cat: "Balls", total: 60, avail: 52, cond: "New", loc: "Net Shed Box 1" },
        { item: "Wicketkeeping & Batting Pads Set", cat: "Protective Gear", total: 10, avail: 8, cond: "Good", loc: "Cricket Pavillion Locker B" }
      ]
    },
    {
      name: "Football (Soccer) Arena",
      desc: "FIFA-grade artificial turf pitch with stadium floodlights, dugout shelters, and regular 7-a-side & 11-a-side leagues.",
      image: "https://images.unsplash.com/photo-1508098682722-e99c43a406b2?auto=format&fit=crop&w=1200&q=80",
      coachName: "Carlos Ramirez",
      coachSpecialty: "UEFA A Certified Tactical Soccer Coach",
      coachBio: "Specialist in counter-pressing formations, athletic conditioning, and youth grassroots development.",
      coachImage: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=500&q=80",
      venue: "Main Turf Football Pitch 1",
      category: "Outdoor Team Sport",
      schedule: { title: "Elite Football Tactics & Drills", days: "Tue, Thu, Sat", start: "05:00 PM", end: "07:30 PM" },
      equipments: [
        { item: "Adidas Pro Match Footballs", cat: "Balls", total: 30, avail: 25, cond: "New", loc: "Sports Complex Room 2" },
        { item: "Agility Training Cones & Ladders", cat: "Training Aids", total: 50, avail: 45, cond: "Good", loc: "Pitch Locker" }
      ]
    },
    {
      name: "Olympic Swimming Complex",
      desc: "50-meter 8-lane temperature-controlled Olympic pool, diving boards, digital touchpads, and qualified lifeguards.",
      image: "https://images.unsplash.com/photo-1576610616656-d3aa5d1f4534?auto=format&fit=crop&w=1200&q=80",
      coachName: "Elena Rostova",
      coachSpecialty: "Olympic Freestyle & Butterfly Coach",
      coachBio: "Former European medalist specialized in stroke mechanics, breath control, and endurance training.",
      coachImage: "https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?auto=format&fit=crop&w=500&q=80",
      venue: "Aquatics Center Pool 1",
      category: "Aquatics",
      schedule: { title: "Competitive Swimming & Stroke Clinic", days: "Mon, Wed, Fri", start: "06:30 AM", end: "08:30 AM" },
      equipments: [
        { item: "Speedo Kickboards & Pull Buoys", cat: "Training Aids", total: 40, avail: 36, cond: "Good", loc: "Poolside Deck Storage" },
        { item: "Electronic Lap Timers", cat: "Court Gear", total: 8, avail: 8, cond: "New", loc: "Aquatics Office" }
      ]
    },
    {
      name: "Lawn & Synthetic Tennis Courts",
      desc: "4 professional synthetic hard courts equipped with high-intensity LED floodlights and automated ball machines.",
      image: "https://images.unsplash.com/photo-1622279457486-62dcc4a431d6?auto=format&fit=crop&w=1200&q=80",
      coachName: "David Becker",
      coachSpecialty: "ITF Level 3 Tennis Coach",
      coachBio: "20 years of international tournament experience, serving clinic specialist, and junior ranking coach.",
      coachImage: "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=500&q=80",
      venue: "Tennis Courts 1 - 4",
      category: "Racquet Sport",
      schedule: { title: "Tennis Masterclass & Serve Clinic", days: "Mon, Wed, Sat", start: "05:00 PM", end: "07:00 PM" },
      equipments: [
        { item: "Wilson Pro Staff Racquets", cat: "Bats & Racquets", total: 20, avail: 16, cond: "Good", loc: "Tennis Pro Shop" },
        { item: "Wilson US Open Tennis Ball Cans", cat: "Balls", total: 100, avail: 85, cond: "New", loc: "Tennis Pro Shop" }
      ]
    },
    {
      name: "Indoor Badminton Arena",
      desc: "4 professional BWF-standard wooden parquet courts with anti-glare overhead illumination and climate control.",
      image: "https://images.unsplash.com/photo-1626224583764-f87db24ac4ea?auto=format&fit=crop&w=1200&q=80",
      coachName: "Lee Wei Kang",
      coachSpecialty: "BWF High Performance Badminton Coach",
      coachBio: "Former Asian Games doubles coach focusing on footwork velocity, smashes, and court agility.",
      coachImage: "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?auto=format&fit=crop&w=500&q=80",
      venue: "Badminton Hall Courts 1 - 4",
      category: "Racquet Sport",
      schedule: { title: "Smash & Agility Badminton Session", days: "Tue, Thu, Sun", start: "06:00 PM", end: "08:00 PM" },
      equipments: [
        { item: "Yonex Astrox 88D Pro Racquets", cat: "Bats & Racquets", total: 25, avail: 20, cond: "Good", loc: "Badminton Desk" },
        { item: "Yonex Aerosensa Shuttlecock Barrels", cat: "Balls", total: 40, avail: 32, cond: "New", loc: "Badminton Desk" }
      ]
    },
    {
      name: "Basketball Championship Court",
      desc: "FIBA certified hardwood court with tempered glass backboards, electronic shot clocks, and stadium seating.",
      image: "https://images.unsplash.com/photo-1546519638-68e109498ffc?auto=format&fit=crop&w=1200&q=80",
      coachName: "Marcus Sterling",
      coachSpecialty: "NCAA Division 1 Experienced Coach",
      coachBio: "Specialist in pick-and-roll offense, perimeter shooting mechanics, and defensive transitions.",
      coachImage: "https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?auto=format&fit=crop&w=500&q=80",
      venue: "Indoor Basketball Arena",
      category: "Indoor Team Sport",
      schedule: { title: "Hoops Shooting & Defensive Drills", days: "Mon, Wed, Fri", start: "07:00 PM", end: "09:00 PM" },
      equipments: [
        { item: "Spalding TF-1000 Legacy Basketballs", cat: "Balls", total: 24, avail: 20, cond: "New", loc: "Basketball Shed" }
      ]
    },
    {
      name: "Glass-Back Squash Courts",
      desc: "3 ASB regulation glass-backed competition squash courts featuring air conditioning and spectator viewing gallery.",
      image: "https://images.unsplash.com/photo-1554068865-24cecd4e34b8?auto=format&fit=crop&w=1200&q=80",
      coachName: "Farhan Zaman",
      coachSpecialty: "PSA World Tour Veteran Coach",
      coachBio: "Ranked among top national players, specializing in nick shots, boast angles, and court endurance.",
      coachImage: "https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?auto=format&fit=crop&w=500&q=80",
      venue: "Squash Courts Complex 1 - 3",
      category: "Racquet Sport",
      schedule: { title: "Squash Wall Drills & Tactical Matchplay", days: "Tue, Thu, Sat", start: "06:00 PM", end: "08:00 PM" },
      equipments: [
        { item: "Dunlop Pro Double Yellow Dot Squash Balls", cat: "Balls", total: 50, avail: 45, cond: "New", loc: "Squash Rack" },
        { item: "Head Graphene Squash Racquets", cat: "Bats & Racquets", total: 12, avail: 10, cond: "Good", loc: "Squash Rack" }
      ]
    },
    {
      name: "Table Tennis Championship Hall",
      desc: "ITTF-approved Donic tables, red Taraflex rubber sports flooring, and automated ball-serving robots.",
      image: "https://images.unsplash.com/photo-1534158914592-062992fbe900?auto=format&fit=crop&w=1200&q=80",
      coachName: "Zhang Ming",
      coachSpecialty: "National Table Tennis Academy Coach",
      coachBio: "Master of loop drives, reverse penhold backhands, and high-frequency spin serves.",
      coachImage: "https://images.unsplash.com/photo-1522075469751-3a6694fb2f61?auto=format&fit=crop&w=500&q=80",
      venue: "Table Tennis Hall 2nd Floor",
      category: "Indoor Sport",
      schedule: { title: "Fast-Paced Spin & Rally Training", days: "Mon, Wed, Fri", start: "05:00 PM", end: "07:00 PM" },
      equipments: [
        { item: "Butterfly Timo Boll ALC Paddles", cat: "Bats & Racquets", total: 18, avail: 15, cond: "Good", loc: "TT Cabinet" },
        { item: "Nittaku 3-Star 40+ Plastic Balls (Pack 120)", cat: "Balls", total: 120, avail: 100, cond: "New", loc: "TT Robot Bin" }
      ]
    },
    {
      name: "Volleyball & Beach Sand Court",
      desc: "Dual setup featuring indoor spring-loaded court and an outdoor deep-sand beach volleyball court with floodlights.",
      image: "https://images.unsplash.com/photo-1612872087720-bb876e2e67d1?auto=format&fit=crop&w=1200&q=80",
      coachName: "Mateo Rossi",
      coachSpecialty: "FIVB Certified Volleyball Strategist",
      coachBio: "Former Italian club coach expert in block-jump timing, spike power, and jump-serve consistency.",
      coachImage: "https://images.unsplash.com/photo-1521119989659-a83eee488004?auto=format&fit=crop&w=500&q=80",
      venue: "Outdoor Sand Arena & Indoor Court",
      category: "Team Sport",
      schedule: { title: "Spiking & Tactical Setting Clinic", days: "Tue, Thu, Sat", start: "04:30 PM", end: "06:30 PM" },
      equipments: [
        { item: "Mikasa V200W Official Match Volleyballs", cat: "Balls", total: 20, avail: 18, cond: "New", loc: "Volleyball Bag" }
      ]
    },
    {
      name: "Martial Arts & Karate Dojo",
      desc: "Traditional Tatami matted dojo, punch bags, wooden dummy makiwara, and certified black belt instruction.",
      image: "https://images.unsplash.com/photo-1555597673-b21d5c935865?auto=format&fit=crop&w=1200&q=80",
      coachName: "Sensei Kenji Takahashi",
      coachSpecialty: "6th Dan Shotokan Karate & Self Defense",
      coachBio: "World Karate Federation accredited master instructor teaching kata, kumite, and mental focus.",
      coachImage: "https://images.unsplash.com/photo-1560250097-0b93528c311a?auto=format&fit=crop&w=500&q=80",
      venue: "Grand Martial Arts Dojo",
      category: "Combat Sport",
      schedule: { title: "Shotokan Karate Kata & Kumite", days: "Mon, Wed, Fri", start: "06:00 PM", end: "08:00 PM" },
      equipments: [
        { item: "Thick Tatami Training Mats", cat: "Court Gear", total: 50, avail: 50, cond: "Good", loc: "Dojo Mat Hall" },
        { item: "Focus Mitts & Kick Shields", cat: "Protective Gear", total: 20, avail: 18, cond: "Good", loc: "Dojo Locker" }
      ]
    },
    {
      name: "Boxing & Kickboxing Ring",
      desc: "Full regulation elevated boxing ring, 12 heavy punching bags, speedballs, and cardiovascular combat conditioning.",
      image: "https://images.unsplash.com/photo-1549719386-74dfcbf7dbed?auto=format&fit=crop&w=1200&q=80",
      coachName: "Tyson 'Iron' Ward",
      coachSpecialty: "Professional Boxing & Kickboxing Coach",
      coachBio: "Former Golden Gloves champion coaching hand speed, evasive head movement, and power punching.",
      coachImage: "https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?auto=format&fit=crop&w=500&q=80",
      venue: "Boxing Studio Ring A",
      category: "Combat Sport",
      schedule: { title: "Boxing Sparring & Footwork Camp", days: "Tue, Thu, Sat", start: "06:30 PM", end: "08:30 PM" },
      equipments: [
        { item: "Everlast Pro 16oz Sparring Gloves", cat: "Protective Gear", total: 24, avail: 20, cond: "Good", loc: "Boxing Rack" },
        { item: "Heavy Leather Punch Bags", cat: "Training Aids", total: 12, avail: 12, cond: "Good", loc: "Boxing Studio" }
      ]
    },
    {
      name: "Athletics & Track and Field",
      desc: "400-meter 8-lane synthetic tartan running track, long jump pit, high jump mats, and hurdle equipment.",
      image: "https://images.unsplash.com/photo-1461896836934-ffe607ba8211?auto=format&fit=crop&w=1200&q=80",
      coachName: "Sarah Jenkins",
      coachSpecialty: "IAAF Sprint & Endurance Coach",
      coachBio: "Track specialist focusing on sprint acceleration, stride biomechanics, and VO2-max intervals.",
      coachImage: "https://images.unsplash.com/photo-1580489944761-15a19d654956?auto=format&fit=crop&w=500&q=80",
      venue: "Outdoor Tartan Athletic Stadium",
      category: "Athletics",
      schedule: { title: "Sprint Acceleration & Distance Cadence", days: "Mon, Wed, Sat", start: "06:00 AM", end: "08:00 AM" },
      equipments: [
        { item: "Aluminum Track Starting Blocks", cat: "Court Gear", total: 8, avail: 8, cond: "New", loc: "Track Shed" },
        { item: "Adjustable Speed Hurdles Set", cat: "Training Aids", total: 20, avail: 20, cond: "Good", loc: "Track Shed" }
      ]
    },
    {
      name: "Archery Range",
      desc: "50-meter outdoor archery range with automated target retrievers, compound & recurve bows, and laser rangefinders.",
      image: "https://images.unsplash.com/photo-1511067007772-9da29974ce44?auto=format&fit=crop&w=1200&q=80",
      coachName: "Robin Vance",
      coachSpecialty: "World Archery Certified Target Master",
      coachBio: "Compound and recurve instructor coaching posture alignment, anchor point consistency, and calm breathing.",
      coachImage: "https://images.unsplash.com/photo-1508214751196-bcfd4ca60f91?auto=format&fit=crop&w=500&q=80",
      venue: "Target Archery Field South",
      category: "Precision Sport",
      schedule: { title: "Precision Target Archery Workshop", days: "Tue, Thu, Sun", start: "03:30 PM", end: "05:30 PM" },
      equipments: [
        { item: "Hoyt Recurve Target Bows (28 lbs)", cat: "Bats & Racquets", total: 10, avail: 8, cond: "Good", loc: "Archery Armory" },
        { item: "Carbon Express Target Arrows (Dozen)", cat: "Training Aids", total: 25, avail: 22, cond: "Good", loc: "Archery Armory" }
      ]
    },
    {
      name: "Snooker & Billiards Club",
      desc: "6 tournament-grade Riley 12ft full-size snooker tables with Strachan 6811 cloth, brass lighting, and cue racks.",
      image: "https://images.unsplash.com/photo-1534423861386-85a16f5d13fd?auto=format&fit=crop&w=1200&q=80",
      coachName: "Arthur Pendelton",
      coachSpecialty: "WPBSA Certified Cue Sports Coach",
      coachBio: "Century break specialist teaching cue-ball positioning, backspin draw, and safety match play.",
      coachImage: "https://images.unsplash.com/photo-1492562080023-ab3db95bfbce?auto=format&fit=crop&w=500&q=80",
      venue: "Snooker Lounge 1st Floor",
      category: "Cue Sport",
      schedule: { title: "Cue Action & Break Building Masterclass", days: "Mon, Wed, Fri", start: "07:00 PM", end: "09:00 PM" },
      equipments: [
        { item: "Handmade Ashwood 3/4 Joint Cues", cat: "Bats & Racquets", total: 15, avail: 14, cond: "New", loc: "Cue Wall Cabinet" },
        { item: "Aramith Tournament Champion Snooker Balls", cat: "Balls", total: 6, avail: 6, cond: "New", loc: "Snooker Tables" }
      ]
    },
    {
      name: "Chess & Mind Sports Academy",
      desc: "Soundproof analytical hall with DGT electronic boards, grandmaster masterclasses, clock blitz, and FIDE tournaments.",
      image: "https://images.unsplash.com/photo-1529699211952-734e80c4d42b?auto=format&fit=crop&w=1200&q=80",
      coachName: "GM Viktor Korchnoi",
      coachSpecialty: "International Grandmaster & FIDE Senior Trainer",
      coachBio: "Author and grandmaster coach training opening repertoires, endgame mastery, and dynamic middlegames.",
      coachImage: "https://images.unsplash.com/photo-1501196354995-cbb51c65aaea?auto=format&fit=crop&w=500&q=80",
      venue: "Mind Sports Pavilion Room 301",
      category: "Mind Sport",
      schedule: { title: "Grandmaster Opening & Tactics Analysis", days: "Tue, Thu, Sat", start: "05:00 PM", end: "07:00 PM" },
      equipments: [
        { item: "DGT 2010 Digital Chess Clocks", cat: "Court Gear", total: 20, avail: 18, cond: "New", loc: "Chess Cabinet A" },
        { item: "Staunton Weighted Wooden Chess Sets", cat: "Training Aids", total: 25, avail: 22, cond: "Good", loc: "Chess Cabinet B" }
      ]
    },
    {
      name: "Field Hockey Astroturf",
      desc: "FIH certified water-based blue astroturf pitch with automated sprinkler system and competition cages.",
      image: "https://images.unsplash.com/photo-1589487391730-58f20eb2c308?auto=format&fit=crop&w=1200&q=80",
      coachName: "Shahbaz Ahmed",
      coachSpecialty: "Olympic Hockey Gold Medalist & Strategist",
      coachBio: "Legendary attacking midfielder coaching scoop techniques, reverse stick strikes, and penalty corner drills.",
      coachImage: "https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=500&q=80",
      venue: "Olympic Blue Astroturf Stadium",
      category: "Outdoor Team Sport",
      schedule: { title: "Penalty Corner Tactics & Dribbling Clinic", days: "Mon, Wed, Fri", start: "04:30 PM", end: "06:30 PM" },
      equipments: [
        { item: "Grays Pro Carbon Hockey Sticks", cat: "Bats & Racquets", total: 22, avail: 19, cond: "Good", loc: "Astroturf Locker" },
        { item: "Kookaburra Dimple Turf Hockey Balls", cat: "Balls", total: 50, avail: 42, cond: "New", loc: "Astroturf Locker" }
      ]
    },
    {
      name: "Cycling & Spin Studio",
      desc: "High-tech immersive spin auditorium with 30 magnetic resistance smart bikes, heart rate projection, and road club rides.",
      image: "https://images.unsplash.com/photo-1534787238916-9ba6764efd4f?auto=format&fit=crop&w=1200&q=80",
      coachName: "Chloe Dupont",
      coachSpecialty: "Pro Peloton & High-Cadence Spin Specialist",
      coachBio: "Triathlete and road cycling coach focused on power thresholds (FTP), cadence rhythms, and sprint intervals.",
      coachImage: "https://images.unsplash.com/photo-1544005313-94ddf0286df2?auto=format&fit=crop&w=500&q=80",
      venue: "Cycling Auditorium Floor 1",
      category: "Endurance Sport",
      schedule: { title: "HIIT Cadence & Power Threshold Ride", days: "Tue, Thu, Sun", start: "07:00 AM", end: "08:15 AM" },
      equipments: [
        { item: "Wattbike Atom Smart Indoor Trainers", cat: "Training Aids", total: 25, avail: 25, cond: "New", loc: "Spin Studio" }
      ]
    },
    {
      name: "Rugby & Touch Football Ground",
      desc: "Full-size natural grass pitch with regulation rugby goalposts, padded safety barriers, and scrum machine.",
      image: "https://images.unsplash.com/photo-1529763486845-0155b46546f3?auto=format&fit=crop&w=1200&q=80",
      coachName: "Liam MacLeod",
      coachSpecialty: "Rugby Union & Touch Tactics Coach",
      coachBio: "Former Premiership forward coach with focus on lineout jumping, maul drive, and passing under pressure.",
      coachImage: "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=500&q=80",
      venue: "Rugby Field North",
      category: "Outdoor Team Sport",
      schedule: { title: "Rugby Passing, Scrums & Conditioning", days: "Tue, Thu, Sat", start: "05:00 PM", end: "07:00 PM" },
      equipments: [
        { item: "Gilbert Rugby Match Balls (Size 5)", cat: "Balls", total: 20, avail: 16, cond: "New", loc: "Rugby Shed" },
        { item: "High-Density Tackle Bags & Shields", cat: "Protective Gear", total: 10, avail: 10, cond: "Good", loc: "Rugby Shed" }
      ]
    },
    {
      name: "Yoga & Dynamic Pilates Studio",
      desc: "Bamboo-floored serene studio with aerial silk hammocks, reformer machines, bolsters, and guided breathwork sessions.",
      image: "https://images.unsplash.com/photo-1506126613408-eca07ce68773?auto=format&fit=crop&w=1200&q=80",
      coachName: "Maya Sharma",
      coachSpecialty: "Ashtanga Yoga & Reformer Pilates Master",
      coachBio: "500-hour certified yogi with holistic expertise in spinal mobility, core activation, and mindfulness meditation.",
      coachImage: "https://images.unsplash.com/photo-1573497019940-1c28c88b4f3e?auto=format&fit=crop&w=500&q=80",
      venue: "Zen Wellness Studio 3rd Floor",
      category: "Wellness & Fitness",
      schedule: { title: "Morning Vinyasa Flow & Deep Core Reform", days: "Mon, Wed, Fri", start: "07:00 AM", end: "08:30 AM" },
      equipments: [
        { item: "Manduka Pro Non-Slip Yoga Mats", cat: "Training Aids", total: 35, avail: 32, cond: "Good", loc: "Yoga Studio Storage" },
        { item: "Pilates Reformer Resistance Straps", cat: "Training Aids", total: 15, avail: 15, cond: "New", loc: "Pilates Room" }
      ]
    },
    {
      name: "Golf & Indoor 4K Simulator",
      desc: "TrackMan 4K golf simulator with 100+ global championship courses, real club feedback, and outdoor putting green.",
      image: "https://images.unsplash.com/photo-1535131749006-b7f58c99034b?auto=format&fit=crop&w=1200&q=80",
      coachName: "Alistair MacIntyre",
      coachSpecialty: "PGA Class A Golf Professional",
      coachBio: "TrackMan certified golf biomechanist specializing in clubhead speed, swing plane path, and short-game precision.",
      coachImage: "https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?auto=format&fit=crop&w=500&q=80",
      venue: "TrackMan Golf Lounge & Putting Green",
      category: "Precision Sport",
      schedule: { title: "Swing Mechanics & TrackMan Launch Analysis", days: "Tue, Thu, Sat", start: "04:00 PM", end: "06:00 PM" },
      equipments: [
        { item: "TaylorMade Stealth Irons & Driver Sets", cat: "Bats & Racquets", total: 8, avail: 7, cond: "New", loc: "Golf Pro Bay" },
        { item: "Titleist Pro V1 Golf Balls (Dozen Box)", cat: "Balls", total: 30, avail: 28, cond: "New", loc: "Golf Pro Bay" }
      ]
    }
  ];

  console.log(`Checking and inserting up to ${sportsList.length} sports...`);

  for (const item of sportsList) {
    // 1. Insert or update Sport
    let sportId;
    const existingSport = await pool.request()
      .input("Name", sql.NVarChar(100), item.name)
      .query("SELECT SportID FROM Sports WHERE SportName = @Name");

    if (existingSport.recordset.length > 0) {
      sportId = existingSport.recordset[0].SportID;
      // Update image and description if needed
      await pool.request()
        .input("SportID", sql.Int, sportId)
        .input("Desc", sql.NVarChar(sql.MAX), item.desc)
        .input("Img", sql.NVarChar(1000), item.image)
        .query("UPDATE Sports SET Description = @Desc, ImageURL = @Img, IsActive = 1 WHERE SportID = @SportID");
    } else {
      const inserted = await pool.request()
        .input("Name", sql.NVarChar(100), item.name)
        .input("Desc", sql.NVarChar(sql.MAX), item.desc)
        .input("Img", sql.NVarChar(1000), item.image)
        .query(`
          INSERT INTO Sports (SportName, Description, ImageURL, IsActive, CreatedAt)
          OUTPUT INSERTED.SportID
          VALUES (@Name, @Desc, @Img, 1, SYSDATETIME())
        `);
      sportId = inserted.recordset[0].SportID;
    }

    // 2. Insert or update Coach
    let coachId;
    const existingCoach = await pool.request()
      .input("CoachName", sql.NVarChar(100), item.coachName)
      .query("SELECT CoachID FROM Coaches WHERE FullName = @CoachName");

    if (existingCoach.recordset.length > 0) {
      coachId = existingCoach.recordset[0].CoachID;
      await pool.request()
        .input("CoachID", sql.Int, coachId)
        .input("SportID", sql.Int, sportId)
        .input("Spec", sql.NVarChar(150), item.coachSpecialty)
        .input("Bio", sql.NVarChar(1000), item.coachBio)
        .input("Img", sql.NVarChar(1000), item.coachImage)
        .query("UPDATE Coaches SET SportID = @SportID, Specialization = @Spec, Bio = @Bio, ImageURL = @Img, IsActive = 1 WHERE CoachID = @CoachID");
    } else {
      const email = item.coachName.toLowerCase().replace(/[^a-z]/g, "") + "@sportshub.com";
      const phone = "+92 321 " + Math.floor(1000000 + Math.random() * 9000000);
      const insertedCoach = await pool.request()
        .input("FullName", sql.NVarChar(100), item.coachName)
        .input("Email", sql.NVarChar(150), email)
        .input("Phone", sql.NVarChar(50), phone)
        .input("SportID", sql.Int, sportId)
        .input("Specialization", sql.NVarChar(150), item.coachSpecialty)
        .input("Bio", sql.NVarChar(1000), item.coachBio)
        .input("ImageURL", sql.NVarChar(1000), item.coachImage)
        .query(`
          INSERT INTO Coaches (FullName, Email, Phone, SportID, Specialization, ExperienceYears, Bio, ImageURL, Rating, IsActive, CreatedAt)
          OUTPUT INSERTED.CoachID
          VALUES (@FullName, @Email, @Phone, @SportID, @Specialization, 8, @Bio, @ImageURL, 4.9, 1, SYSDATETIME())
        `);
      coachId = insertedCoach.recordset[0].CoachID;
    }

    // 3. Training Schedule for this sport
    if (item.schedule) {
      const schedCheck = await pool.request()
        .input("SportID", sql.Int, sportId)
        .query("SELECT COUNT(*) AS count FROM TrainingSchedules WHERE SportID = @SportID");
      if (schedCheck.recordset[0].count === 0) {
        await pool.request()
          .input("SportID", sql.Int, sportId)
          .input("CoachID", sql.Int, coachId)
          .input("Title", sql.NVarChar(150), item.schedule.title)
          .input("Days", sql.NVarChar(100), item.schedule.days)
          .input("Start", sql.NVarChar(20), item.schedule.start)
          .input("End", sql.NVarChar(20), item.schedule.end)
          .input("Venue", sql.NVarChar(200), item.venue)
          .query(`
            INSERT INTO TrainingSchedules (SportID, CoachID, SessionTitle, DaysOfWeek, StartTime, EndTime, Venue, SkillLevel, MaxCapacity, IsActive, CreatedAt)
            VALUES (@SportID, @CoachID, @Title, @Days, @Start, @End, @Venue, 'All Levels', 30, 1, SYSDATETIME())
          `);
      }
    }

    // 4. Equipment items
    if (item.equipments) {
      for (const eq of item.equipments) {
        const eqCheck = await pool.request()
          .input("SportID", sql.Int, sportId)
          .input("ItemName", sql.NVarChar(150), eq.item)
          .query("SELECT COUNT(*) AS count FROM Equipment WHERE SportID = @SportID AND ItemName = @ItemName");
        if (eqCheck.recordset[0].count === 0) {
          await pool.request()
            .input("SportID", sql.Int, sportId)
            .input("ItemName", sql.NVarChar(150), eq.item)
            .input("Cat", sql.NVarChar(100), eq.cat)
            .input("Tot", sql.Int, eq.total)
            .input("Avail", sql.Int, eq.avail)
            .input("Cond", sql.NVarChar(50), eq.cond)
            .input("Loc", sql.NVarChar(150), eq.loc)
            .query(`
              INSERT INTO Equipment (SportID, ItemName, Category, TotalQuantity, AvailableQuantity, Condition, StorageLocation, CreatedAt)
              VALUES (@SportID, @ItemName, @Cat, @Tot, @Avail, @Cond, @Loc, SYSDATETIME())
            `);
        }
      }
    }
  }

  // 5. Seed Initial Teams & Tournaments
  await seedTeamsAndTournaments(pool);

  console.log("Successfully seeded 20 sports, coaches, equipment, and schedules!");
};

const seedTeamsAndTournaments = async (pool) => {
  // Check teams
  const teamCheck = await pool.request().query("SELECT COUNT(*) AS count FROM Teams");
  if (teamCheck.recordset[0].count === 0) {
    console.log("Seeding club sports teams...");
    const sampleTeams = [
      { name: "Z Titans Cricket XI", sportName: "Cricket Pavilion & Nets" },
      { name: "Z Strikers FC", sportName: "Football (Soccer) Arena" },
      { name: "Z Hawks Basketball", sportName: "Basketball Championship Court" },
      { name: "Z Waves Waterpolo", sportName: "Olympic Swimming Complex" },
      { name: "Z Smashers Badminton", sportName: "Indoor Badminton Arena" }
    ];

    for (const t of sampleTeams) {
      const sp = await pool.request()
        .input("Name", sql.NVarChar(100), t.sportName)
        .query("SELECT SportID FROM Sports WHERE SportName = @Name");
      if (sp.recordset.length > 0) {
        const sportId = sp.recordset[0].SportID;
        const coach = await pool.request()
          .input("SportID", sql.Int, sportId)
          .query("SELECT TOP 1 CoachID FROM Coaches WHERE SportID = @SportID");
        const coachId = coach.recordset.length > 0 ? coach.recordset[0].CoachID : null;

        await pool.request()
          .input("TeamName", sql.NVarChar(100), t.name)
          .input("SportID", sql.Int, sportId)
          .input("CoachID", sql.Int, coachId)
          .query(`
            INSERT INTO Teams (TeamName, SportID, CoachID, Status, CreatedAt)
            VALUES (@TeamName, @SportID, @CoachID, 'Active', SYSDATETIME())
          `);
      }
    }
  }

  // Check Tournaments
  const tournCheck = await pool.request().query("SELECT COUNT(*) AS count FROM Tournaments");
  if (tournCheck.recordset[0].count === 0) {
    console.log("Seeding initial Tournaments & Matches...");
    const cricketSport = await pool.request().query("SELECT TOP 1 SportID FROM Sports WHERE SportName LIKE '%Cricket%'");
    const tennisSport = await pool.request().query("SELECT TOP 1 SportID FROM Sports WHERE SportName LIKE '%Tennis%'");
    const footballSport = await pool.request().query("SELECT TOP 1 SportID FROM Sports WHERE SportName LIKE '%Football%'");

    if (cricketSport.recordset.length > 0) {
      const cSportId = cricketSport.recordset[0].SportID;
      const tournRes = await pool.request()
        .input("Name", sql.NVarChar(150), "Z Premier Cricket Trophy 2026")
        .input("SportID", sql.Int, cSportId)
        .input("Desc", sql.NVarChar(1000), "Annual knockout club championship featuring premier club divisions.")
        .input("Type", sql.NVarChar(50), "Knockout")
        .input("Start", sql.DateTime2, new Date(Date.now() + 10 * 24 * 60 * 60 * 1000))
        .input("End", sql.DateTime2, new Date(Date.now() + 18 * 24 * 60 * 60 * 1000))
        .input("Venue", sql.NVarChar(200), "Main Cricket Stadium")
        .input("Prize", sql.NVarChar(100), "PKR 150,000 + Gold Cup")
        .query(`
          INSERT INTO Tournaments (TournamentName, SportID, Description, TournamentType, StartDate, EndDate, Venue, PrizePool, Status, CreatedAt)
          OUTPUT INSERTED.TournamentID
          VALUES (@Name, @SportID, @Desc, @Type, @Start, @End, @Venue, @Prize, 'Upcoming', SYSDATETIME())
        `);

      const tournId = tournRes.recordset[0].TournamentID;

      // Add a couple matches
      await pool.request()
        .input("TournID", sql.Int, tournId)
        .input("SportID", sql.Int, cSportId)
        .input("Title", sql.NVarChar(150), "Quarter-Final 1: Z Titans vs Lahore Royals")
        .input("Part1", sql.NVarChar(100), "Z Titans XI")
        .input("Part2", sql.NVarChar(100), "Lahore Royals XI")
        .input("MDate", sql.DateTime2, new Date(Date.now() + 11 * 24 * 60 * 60 * 1000))
        .input("MVenue", sql.NVarChar(200), "Main Stadium Pitch 1")
        .input("MStage", sql.NVarChar(50), "Quarter-Final")
        .query(`
          INSERT INTO TournamentMatches (TournamentID, SportID, MatchTitle, Participant1Name, Participant2Name, MatchDate, Venue, Stage, Status, CreatedAt)
          VALUES (@TournID, @SportID, @Title, @Part1, @Part2, @MDate, @MVenue, @MStage, 'Scheduled', SYSDATETIME())
        `);
    }

    if (footballSport.recordset.length > 0) {
      const fSportId = footballSport.recordset[0].SportID;
      await pool.request()
        .input("Name", sql.NVarChar(150), "Super Futsal Champions Cup")
        .input("SportID", sql.Int, fSportId)
        .input("Desc", sql.NVarChar(1000), "High-speed 7-a-side floodlit tournament with group stages and finals.")
        .input("Type", sql.NVarChar(50), "League")
        .input("Start", sql.DateTime2, new Date(Date.now() + 15 * 24 * 60 * 60 * 1000))
        .input("End", sql.DateTime2, new Date(Date.now() + 22 * 24 * 60 * 60 * 1000))
        .input("Venue", sql.NVarChar(200), "Main Turf Arena")
        .input("Prize", sql.NVarChar(100), "PKR 100,000 + Silver Shield")
        .query(`
          INSERT INTO Tournaments (TournamentName, SportID, Description, TournamentType, StartDate, EndDate, Venue, PrizePool, Status, CreatedAt)
          VALUES (@Name, @SportID, @Desc, @Type, @Start, @End, @Venue, @Prize, 'Upcoming', SYSDATETIME())
        `);
    }
  }

  // Check and seed initial sample enrollments & athlete evaluations
  const enrollCheck = await pool.request().query("SELECT COUNT(*) AS count FROM SportEnrollments");
  if (enrollCheck.recordset[0].count === 0) {
    const activeMembers = await pool.request().query("SELECT TOP 3 UserID FROM Memberships WHERE MembershipStatus = 'Active'");
    if (activeMembers.recordset.length > 0) {
      const u1 = activeMembers.recordset[0].UserID;
      await pool.request().query(`
        INSERT INTO SportEnrollments (UserID, SportID, CoachID, SkillLevel, Status, EnrolledAt)
        VALUES (${u1}, 1, 1, 'Intermediate', 'Active', SYSDATETIME());

        INSERT INTO Attendance (UserID, SportID, SessionDate, Status, Remarks, CreatedAt)
        VALUES (${u1}, 1, CAST(SYSDATETIME() AS DATE), 'Present', 'Completed power hitting drills and sprint intervals', SYSDATETIME());

        INSERT INTO MemberPerformance (UserID, SportID, CoachID, EvaluationDate, FitnessScore, SkillScore, AttendanceScore, MatchesPlayed, MatchesWon, CoachFeedback, NextMilestones, CreatedAt)
        VALUES (${u1}, 1, 1, CAST(SYSDATETIME() AS DATE), 94, 89, 96, 8, 6, 'Outstanding athletic conditioning and technical discipline during inter-club fixtures.', 'Advanced spin facing and captaincy tactics', SYSDATETIME());
      `);
    }
  }
};

module.exports = { initSportsModules };

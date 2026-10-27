require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const users = await db
    .collection('users')
    .find({
      $or: [{ email: /ferz/i }, { email: /dental\.com/i }, { fullName: /ferz/i }],
    })
    .project({ fullName: 1, email: 1, role: 1, isActive: 1 })
    .limit(30)
    .toArray();
  console.log(
    JSON.stringify(
      {
        matches: users.map((u) => ({
          email: u.email,
          fullName: u.fullName,
          role: u.role,
          isActive: u.isActive,
        })),
      },
      null,
      2
    )
  );
  const roles = await db
    .collection('users')
    .aggregate([{ $group: { _id: '$role', n: { $sum: 1 } } }, { $sort: { n: -1 } }])
    .toArray();
  console.log(JSON.stringify(roles));
  await mongoose.disconnect();
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});

const { resolveAuction: r } = require('./engine');
const a = require('assert');
// Rulebook ex 1: A21 B18, others lower, pot 10, all 10
let x = r({A:10,B:10,C:10,D:10,E:10},{A:21,B:18,C:16,D:16,E:10},10,['A','B','C','D','E']);
a.deepStrictEqual(x.inv,{A:17,B:13,C:10,D:10,E:10});
// Ex 2: 3p A60 B30 C8 pot 10 -> A,B bust to 0, C gets 10
x = r({A:10,B:10,C:10},{A:60,B:30,C:8},10,['A','B','C']);
a.deepStrictEqual(x.inv,{A:0,B:0,C:20});
// Ex 3: tie at top 35, pot 21 -> +10 each
x = r({A:10,B:10,C:10,D:10},{A:35,B:35,C:20,D:28},21,['A','B','C','D']);
a.deepStrictEqual(x.inv,{A:20,B:20,C:10,D:10});
// 2p bust keeps inventory, other takes pot
x = r({A:10,B:10},{A:50,B:5},10,['A','B']);
a.deepStrictEqual(x.inv,{A:10,B:20});
// tie for second splits premium
x = r({A:10,B:10,C:10},{A:15,B:10,C:10},10,['A','B','C']);
a.deepStrictEqual(x.inv,{A:15,B:12,C:12});
console.log('all pass');

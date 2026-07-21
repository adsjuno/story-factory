'use strict';

/**
 * Bang GIOI TINH cua ten trong pool US (de validate DNA: ten phai khop vai).
 *  'F' nu, 'M' nam, 'U' luong tinh / khong ro -> KHONG dung cho vai can ro gioi.
 *
 * Nguon: hero_name (50 nu + 50 nam) va villain_name (ten con/chau, tron).
 * Ten luong tinh (Ashley, Morgan, Bailey, Sloane, Blake...) danh 'U' de tranh nham vai.
 */

const FEMALE = [
  // hero nu
  'Dorothy', 'Margaret', 'Ruth', 'Helen', 'Betty', 'Barbara', 'Shirley', 'Joan',
  'Carol', 'Sandra', 'Nancy', 'Judith', 'Linda', 'Patricia', 'Sharon', 'Susan',
  'Carolyn', 'Janet', 'Diane', 'Kathleen', 'Gloria', 'Joyce', 'Evelyn', 'Marilyn',
  'Rose', 'Frances', 'Martha', 'Doris', 'Jean', 'Lois', 'Virginia', 'Anne',
  'Alice', 'Marie', 'Wanda', 'Bonnie', 'Irene', 'Gladys', 'Edith', 'Norma',
  'Beverly', 'Peggy', 'Ellen', 'Rita', 'Vivian', 'Lorraine', 'Geraldine', 'Phyllis',
  'June', 'Constance',
  // villain nu (con/chau)
  'Brittany', 'Megan', 'Lauren', 'Courtney', 'Whitney', 'Chelsea', 'Tiffany', 'Bethany',
  'Madison', 'Kaylee', 'Sierra', 'Paige', 'Kayla', 'Amber', 'Heather', 'Crystal',
];

const MALE = [
  // hero nam
  'Walter', 'Harold', 'Frank', 'Raymond', 'Eugene', 'Ronald', 'Gerald', 'Donald',
  'Roy', 'Earl', 'Arthur', 'Albert', 'Ralph', 'Howard', 'Fred', 'Lawrence',
  'Willie', 'Clarence', 'Leonard', 'Ernest', 'Russell', 'Wayne', 'Roger', 'Melvin',
  'Vernon', 'Lloyd', 'Glenn', 'Chester', 'Marvin', 'Herbert', 'Stanley', 'Norman',
  'Dale', 'Floyd', 'Carl', 'Leon', 'Alvin', 'Elmer', 'Wallace', 'Franklin',
  'George', 'Charles', 'Robert', 'Richard', 'Thomas', 'Joseph', 'Edward', 'William',
  'Henry', 'Samuel',
  // villain nam (con/chau)
  'Ethan', 'Brandon', 'Tyler', 'Kevin', 'Brett', 'Chad', 'Trevor', 'Preston',
  'Derek', 'Connor', 'Hunter', 'Austin', 'Cody', 'Jared', 'Spencer', 'Grant',
  'Colton', 'Dylan', 'Mason',
];

// Luong tinh -> khong dung cho vai can ro gioi
const UNISEX = ['Ashley', 'Blake', 'Sloane', 'Morgan', 'Bailey'];

const F = new Set(FEMALE.map((n) => n.toLowerCase()));
const M = new Set(MALE.map((n) => n.toLowerCase()));
const U = new Set(UNISEX.map((n) => n.toLowerCase()));

// Lay tu dau tien (phong khi ten day du) roi tra 'F' | 'M' | 'U'
function gender(name) {
  const first = String(name || '').trim().split(/\s+/)[0].toLowerCase();
  if (!first) return 'U';
  if (U.has(first)) return 'U';
  if (F.has(first)) return 'F';
  if (M.has(first)) return 'M';
  return 'U'; // khong biet -> coi la khong ro (an toan: se bi loai o vai can ro gioi)
}

module.exports = { gender, FEMALE, MALE, UNISEX };

// Language-neutral hub nodes for generic keywords (Method, Function, for...).
// Searching such a word used to land on whichever language owned a node of
// that name; now it lands on a root hub that explains the idea in general
// and relates to every language's own node. Idempotent (import-md finds the
// hubs by title).
//
//   node server/add-generic-hubs.mjs          apply (backs up data.db first)
//   DRY=1 node server/add-generic-hubs.mjs    list hubs + matched nodes only
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DB_PATH } from './db.js';
import { importFiles } from './import-md.mjs';

process.on('uncaughtException', (e) => { console.error(e); process.exit(1); });
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'content', 'generic', 'hubs.md');

// match: regex over a language node's own title (without the "(Language)" tag).
const HUBS = [
  { title: 'Method', match: /^(class )?methods?\b/, aliases: 'phương thức; method; hàm thành viên; instance method; static method',
    desc: 'A function that belongs to a class or object and works on its data.',
    body: 'Phương thức (method) là hàm gắn với một lớp hoặc đối tượng và thường làm việc trên dữ liệu của chính đối tượng đó. Gọi qua đối tượng (`obj.method()`) thì phương thức nhận đối tượng làm ngữ cảnh (`this` / `self`). Có phương thức thể hiện (instance), phương thức tĩnh (static, thuộc về lớp) và phương thức trừu tượng (chỉ khai báo, lớp con cài đặt). Cú pháp và cách khai báo khác nhau theo từng ngôn ngữ, xem các node liên quan.' },
  { title: 'Function', match: /^functions?\b/, aliases: 'hàm; function; subroutine; procedure; hàm số',
    desc: 'A named block of code that takes inputs, runs, and may return a result.',
    body: 'Hàm (function) là khối mã có tên, nhận đầu vào (tham số), thực hiện một việc và có thể trả về kết quả. Hàm giúp tái sử dụng mã và chia chương trình thành phần nhỏ. Các ngôn ngữ khác nhau ở cú pháp khai báo, giá trị mặc định, số lượng tham số tùy ý, và việc hàm có là giá trị hạng nhất (truyền đi như dữ liệu) hay không.' },
  { title: 'Variable', match: /^variables?\b/, aliases: 'biến; variable; khai báo biến; gán giá trị',
    desc: 'A named storage place for a value that a program can read and change.',
    body: 'Biến (variable) là một tên gắn với vùng nhớ chứa giá trị mà chương trình có thể đọc và thay đổi. Ngôn ngữ kiểu tĩnh bắt khai báo kiểu (`int x`), ngôn ngữ kiểu động để kiểu theo giá trị. Nhiều ngôn ngữ có thêm hằng (không gán lại được) và quy tắc phạm vi cho biết tên được dùng ở đâu.' },
  { title: 'Operators', match: /^operators?\b|^ternary operator$|^operator overloading$/, aliases: 'toán tử; operator; phép toán; ternary',
    desc: 'Symbols that combine or compare values: arithmetic, comparison, logical, assignment.',
    body: 'Toán tử (operator) là ký hiệu thực hiện một phép trên một hay nhiều giá trị: số học (`+ - * /`), so sánh (`== < >`), logic (`&& || !`), gán (`= +=`), bit và toán tử ba ngôi (`điều kiện ? a : b`). Thứ tự ưu tiên và cách xử lý chia nguyên, so sánh bằng, kiểu ngầm định khác nhau theo ngôn ngữ.' },
  { title: 'for', match: /^(for|foreach|for\.\.\.of|for\.\.\.in|for-in|for\.\.\.of loop)$/, aliases: 'vòng lặp for; for loop; foreach; lặp; for each',
    desc: 'A loop that repeats a block, usually over a counter range or the items of a collection.',
    body: 'Vòng lặp `for` lặp lại một khối lệnh, thường theo bộ đếm (`for (i = 0; i < n; i++)`) hoặc theo từng phần tử của một tập (`for x in items`, `foreach`). Nhiều ngôn ngữ có cả hai dạng: for kiểu bộ đếm của họ C và for-each duyệt tập hợp. `break` dừng sớm, `continue` bỏ qua lượt hiện tại.' },
  { title: 'while', match: /^(while|do-while|while \/ do-while|repeat)$/, aliases: 'vòng lặp while; while loop; do while; lặp theo điều kiện',
    desc: 'A loop that repeats as long as a condition stays true.',
    body: 'Vòng lặp `while` kiểm tra điều kiện trước mỗi lượt và dừng khi điều kiện sai; `do-while` chạy thân vòng lặp ít nhất một lần rồi mới kiểm tra. Dùng khi chưa biết trước số lần lặp. Cẩn thận điều kiện không bao giờ sai sẽ gây vòng lặp vô hạn.' },
  { title: 'if / else', match: /^(if|if \/ else|if expression|if \/ elseif \/ else|if \/ elif \/ else)$/, aliases: 'if; rẽ nhánh; điều kiện; if else; câu lệnh điều kiện; conditional',
    desc: 'Runs one branch of code or another depending on whether a condition is true.',
    body: 'Câu lệnh điều kiện `if / else` chọn nhánh mã để chạy tùy điều kiện đúng hay sai. Có thể nối nhiều nhánh bằng `else if` / `elif`. Một số ngôn ngữ (Kotlin, Rust, Scala) coi `if` là biểu thức trả về giá trị; số khác có thêm toán tử ba ngôi hoặc `unless`.' },
  { title: 'switch', match: /^switch( statement)?$/, aliases: 'switch case; câu lệnh switch; rẽ nhánh nhiều trường hợp; match',
    desc: 'Chooses one of many branches by comparing one value against several cases.',
    body: '`switch` so sánh một giá trị với nhiều trường hợp (`case`) và chạy nhánh khớp, thay cho chuỗi `if / else` dài. Ở họ C cần `break` để không rơi sang nhánh kế (fall-through); các ngôn ngữ hiện đại có `match` hoặc `when` mạnh hơn, hỗ trợ khớp mẫu và trả về giá trị.' },
  { title: 'array', match: /^(array|arrays)$/, aliases: 'mảng; array; danh sách phần tử; list',
    desc: 'An ordered sequence of items accessed by a numeric index.',
    body: 'Mảng (array) là dãy phần tử có thứ tự, truy cập bằng chỉ số bắt đầu từ 0. Mảng kiểu tĩnh có kích thước cố định và cùng kiểu phần tử; mảng động (list, vector, slice) co giãn theo nhu cầu. Truy cập ngoài giới hạn có thể báo lỗi hoặc trả về giá trị rỗng tùy ngôn ngữ.' },
  { title: 'set', match: /^(set|set operations)$/, aliases: 'tập hợp; set; hợp giao hiệu; phần tử duy nhất',
    desc: 'A collection of unique values with fast membership tests.',
    body: 'Tập hợp (set) chứa các giá trị không trùng nhau và kiểm tra "có chứa không" rất nhanh. Hỗ trợ các phép hợp, giao, hiệu. Thứ tự duyệt có thể không được đảm bảo tùy ngôn ngữ và cách cài đặt (băm hoặc cây).' },
  { title: 'map', match: /^map$/, aliases: 'bản đồ; map; dictionary; ánh xạ; key value; từ điển',
    desc: 'A collection of key-value pairs looked up by key.',
    body: 'Map (còn gọi dictionary, hash map, associative array) lưu cặp khóa - giá trị và tra giá trị theo khóa rất nhanh. Khóa thường phải duy nhất. Tên gọi và kiểu khóa cho phép khác nhau theo ngôn ngữ: `dict` của Python, `HashMap` của Java, `Map` của JavaScript, `map` của Go.' },
  { title: 'Data types', match: /^(basic types|variables & data types|data types?)$/, aliases: 'kiểu dữ liệu; data type; kiểu cơ bản; primitive; số chuỗi boolean',
    desc: 'The kinds of values a language works with: numbers, text, booleans and so on.',
    body: 'Kiểu dữ liệu quyết định giá trị có thể là gì và làm được phép gì: số nguyên, số thực, chuỗi, boolean, ký tự, và các kiểu phức hợp (mảng, đối tượng). Ngôn ngữ kiểu tĩnh kiểm tra kiểu lúc biên dịch, kiểu động kiểm tra lúc chạy; kích thước số nguyên và cách xử lý null cũng khác nhau.' },
  { title: 'Exception', match: /^(custom )?exceptions?$|^try \/ catch \/ finally$/, aliases: 'ngoại lệ; exception; try catch; xử lý lỗi; throw',
    desc: 'An error signal that interrupts normal flow and can be caught and handled.',
    body: 'Ngoại lệ (exception) là tín hiệu lỗi làm gián đoạn luồng chạy bình thường, đi ngược lên chuỗi gọi cho tới khi có `try / catch` xử lý. `finally` luôn chạy để dọn dẹp. Một số ngôn ngữ (Go, Rust) dùng giá trị trả về thay cho ngoại lệ; có thể tự định nghĩa lớp ngoại lệ riêng.' },
  { title: 'Generic', was: 'Generics', match: /^generics?$/, aliases: 'generics; kiểu tổng quát; generic; template; tham số kiểu',
    desc: 'Code written once that works for many types, with the type given as a parameter.',
    body: 'Generics cho phép viết một hàm hoặc kiểu dùng được với nhiều kiểu dữ liệu mà vẫn giữ kiểm tra kiểu (`List<T>`). Tên gọi khác: template (C++). Có thể giới hạn tham số kiểu bằng ràng buộc (trait, interface, bound).' },
  { title: 'Closure', match: /^closures?$/, aliases: 'bao đóng; closure; hàm lồng giữ biến; lexical scope',
    desc: 'A function that remembers the variables of the scope where it was created.',
    body: 'Closure là hàm "nhớ" các biến của phạm vi nơi nó được tạo, kể cả khi phạm vi đó đã kết thúc. Nó giữ chính biến (không phải bản sao giá trị). Dùng để tạo hàm có trạng thái riêng, callback và bộ đếm.' },
  { title: 'Struct', match: /^(structs?|records?)$/, aliases: 'cấu trúc; struct; record; kiểu bản ghi; dữ liệu có trường',
    desc: 'A composite type that groups named fields into one value.',
    body: 'Struct (hay record) gom nhiều trường có tên vào một kiểu. Khác với lớp ở chỗ thường là kiểu giá trị, ít hoặc không có kế thừa. Một số ngôn ngữ cho record bất biến và tự sinh so sánh, in ra.' },
  { title: 'Trait', match: /^(trait|mixins)$/, aliases: 'đặc tính; trait; mixin; tái sử dụng hành vi',
    desc: 'A reusable set of methods that types can adopt without inheriting from a class.',
    body: 'Trait (và mixin) là tập phương thức dùng lại được, gắn vào nhiều kiểu mà không cần kế thừa từ một lớp. Rust có trait, PHP có trait, Ruby và Dart có mixin. Đây là cách chia sẻ hành vi ngang hàng thay vì kế thừa dọc.' },
  { title: 'Optional', match: /^(optional|option|guard)$/, aliases: 'giá trị tùy chọn; optional; option; có thể thiếu; null safety',
    desc: 'A type that is either a value or nothing, making missing values explicit.',
    body: 'Optional (Option, Maybe) là kiểu hoặc chứa giá trị hoặc rỗng, giúp việc "có thể không có giá trị" thể hiện rõ trong kiểu thay vì dùng `null`. Nhờ vậy trình biên dịch buộc bạn xử lý trường hợp thiếu.' },
  { title: 'Pattern matching', match: /^pattern matching$/, aliases: 'khớp mẫu; pattern matching; match; destructuring',
    desc: 'Testing a value against shapes and extracting parts of it in one step.',
    body: 'Khớp mẫu (pattern matching) kiểm tra một giá trị theo hình dạng và đồng thời tách các phần của nó ra thành biến. Mạnh hơn `switch` thường vì khớp được cấu trúc lồng nhau và điều kiện bảo vệ.' },
  { title: 'Coroutine', match: /^coroutines?$/, aliases: 'coroutine; đồng quy trình; tác vụ bất đồng bộ nhẹ',
    desc: 'A lightweight task that can pause and resume without blocking a thread.',
    body: 'Coroutine là tác vụ nhẹ có thể tạm dừng và chạy tiếp mà không chặn luồng hệ điều hành. Là nền tảng của async/await và các thư viện bất đồng bộ trong nhiều ngôn ngữ.' },
  { title: 'Abstract class', match: /^(abstract class|sealed class)$/, aliases: 'lớp trừu tượng; abstract class; sealed class; lớp cơ sở',
    desc: 'A class that cannot be instantiated and defines a contract for subclasses.',
    body: 'Lớp trừu tượng không tạo trực tiếp thành đối tượng; nó định nghĩa khung chung và phương thức trừu tượng mà lớp con phải cài đặt. Lớp `sealed` giới hạn tập lớp con được phép.' },
  { title: 'Access modifiers', match: /^access modifiers$/, aliases: 'phạm vi truy cập; public private protected; access modifier; encapsulation',
    desc: 'Keywords that control which code may use a class member.',
    body: 'Từ khóa điều khiển truy cập (`public`, `private`, `protected`, `internal`) quy định mã nào được dùng một thành viên của lớp. Là công cụ chính của tính đóng gói (encapsulation).' },
  { title: 'Type conversion', match: /^(type conversion|type casting|number conversions)$/, aliases: 'ép kiểu; type conversion; casting; chuyển kiểu',
    desc: 'Turning a value of one type into another, explicitly or implicitly.',
    body: 'Chuyển kiểu đổi giá trị từ kiểu này sang kiểu khác. Ngầm định (implicit) do ngôn ngữ tự làm, tường minh (cast) do bạn viết. Chuyển kiểu có thể mất độ chính xác hoặc báo lỗi nếu giá trị không hợp lệ.' },
  { title: 'Logging', match: /^logging$/, aliases: 'ghi log; logging; nhật ký; log level',
    desc: 'Recording what a program does at runtime, with levels such as info and error.',
    body: 'Ghi log là ghi lại những gì chương trình làm lúc chạy, theo mức (debug, info, warn, error), để theo dõi và tìm lỗi. Nên dùng thư viện log thay vì in thẳng ra màn hình.' },
  { title: 'String interpolation', match: /^(string interpolation|string\.format\(\))$/, aliases: 'chèn biến vào chuỗi; string interpolation; format string; template string',
    desc: 'Embedding values or expressions directly inside a string.',
    body: 'Chèn giá trị hoặc biểu thức vào giữa chuỗi: template string của JavaScript, f-string của Python, `${}` của Kotlin, `format` của Java. Dễ đọc hơn việc nối chuỗi bằng `+`.' },
  { title: 'File I/O', match: /^(reading & writing files|file i\/o)$/, aliases: 'đọc ghi tệp; file io; file input output; đọc file; ghi file',
    desc: 'Reading data from and writing data to files on disk.',
    body: 'Đọc và ghi tệp: mở tệp, đọc hoặc ghi nội dung, rồi đóng lại (hoặc để cấu trúc `with` / `using` / `defer` tự đóng). Cần xử lý lỗi khi tệp không tồn tại hoặc thiếu quyền.' },
  { title: 'Code coverage', match: /^code coverage$/, aliases: 'độ phủ mã; code coverage; test coverage; coverage',
    desc: 'The share of code executed by tests, used to spot untested parts.',
    body: 'Độ phủ mã đo phần trăm dòng, nhánh hoặc hàm được chạy qua khi kiểm thử, giúp tìm phần chưa có test. Độ phủ cao không đảm bảo test tốt, nhưng độ phủ thấp chắc chắn là điểm yếu.' },
  { title: 'JSON', match: /^json$/, aliases: 'json; JavaScript Object Notation; định dạng dữ liệu; parse json',
    desc: 'A plain-text data format of objects, arrays, strings, numbers and booleans.',
    body: 'JSON là định dạng dữ liệu văn bản gồm đối tượng, mảng, chuỗi, số, boolean và null. Hầu hết ngôn ngữ có hàm chuyển giữa chuỗi JSON và cấu trúc dữ liệu (parse / stringify, serialize / deserialize).' },
  { title: 'Class', match: /^(class|classes|class & object|class & oop|classes in \w+)$/, aliases: 'lớp; class; hướng đối tượng; oop; đối tượng',
    desc: 'A blueprint that defines the fields and methods of the objects created from it.',
    body: 'Lớp (class) là khuôn mẫu định nghĩa trường (dữ liệu) và phương thức (hành vi) của các đối tượng tạo ra từ nó. Là nền của lập trình hướng đối tượng cùng kế thừa, đóng gói và đa hình. Một số ngôn ngữ không có lớp (Go, C) mà dùng struct và hàm; JavaScript dùng prototype bên dưới cú pháp class.' },
  { title: 'Interface', match: /^(interfaces?|interface & type|interfaces? & .*)$/, aliases: 'giao diện; interface; hợp đồng kiểu; contract',
    desc: 'A contract listing the members a type must provide, without implementing them.',
    body: 'Interface là hợp đồng liệt kê những thành viên mà một kiểu phải cung cấp, không chứa cài đặt. Cho phép nhiều kiểu khác nhau dùng thay thế nhau qua cùng một giao diện. Java và C# bắt khai báo `implements`; Go và TypeScript khớp theo hình dạng (structural).' },
  { title: 'Enum', match: /^enums?\b/, aliases: 'kiểu liệt kê; enum; enumeration; hằng liệt kê',
    desc: 'A type with a fixed set of named values.',
    body: 'Enum là kiểu có tập giá trị cố định, mỗi giá trị có tên. Giúp mã dễ đọc và tránh số hay chuỗi "ma thuật". Rust và Swift cho enum mang dữ liệu đi kèm; Java enum là lớp; Python và TypeScript có enum dạng thư viện hoặc cú pháp riêng.' },
  { title: 'Module', also: ['JavaScript module', 'Package'], match: /^modules?$/, aliases: 'mô-đun; module; import export; tách tệp; namespace',
    desc: 'A unit of code in its own file or namespace that other code can import.',
    body: 'Module là đơn vị mã nằm trong tệp hoặc không gian tên riêng để mã khác nhập (import) vào dùng. Giúp chia chương trình, tránh trùng tên và che phần nội bộ. Cú pháp khác nhau: `import` của Python và JavaScript, `package` của Java và Go, `use` của Rust.' },
  { title: 'Constructor', match: /^constructors?\b/, aliases: 'hàm khởi tạo; constructor; khởi tạo đối tượng; init',
    desc: 'Special code that sets up a new object when it is created.',
    body: 'Hàm khởi tạo (constructor) là mã đặc biệt chạy khi tạo đối tượng mới để đặt giá trị ban đầu cho các trường. Tên khác nhau: `constructor` (JavaScript), `__init__` (Python), `init` (Swift), trùng tên lớp (Java, C#).' },
  { title: 'Inheritance', match: /^inheritance\b/, aliases: 'kế thừa; inheritance; extends; lớp con; lớp cha',
    desc: 'A class reusing and extending the members of another class.',
    body: 'Kế thừa cho phép lớp con dùng lại và mở rộng thành viên của lớp cha (`extends`, `: Base`). Hỗ trợ đa hình nhưng dễ tạo cây phân cấp cứng; nhiều người ưu tiên kết hợp (composition) hoặc trait. Một số ngôn ngữ chỉ cho kế thừa đơn.' },
  { title: 'Pointer', match: /^pointers?$/, aliases: 'con trỏ; pointer; địa chỉ bộ nhớ; reference',
    desc: 'A value holding the memory address of another value.',
    body: 'Con trỏ (pointer) là giá trị lưu địa chỉ bộ nhớ của giá trị khác. Cho phép truyền dữ liệu lớn không sao chép và dựng cấu trúc liên kết nhưng dễ gây lỗi (null, treo con trỏ). C và C++ dùng trực tiếp, Go có con trỏ an toàn hơn, Rust thay bằng tham chiếu có kiểm tra.' },
  { title: 'List', match: /^list$/, aliases: 'danh sách; list; dãy phần tử; mảng động',
    desc: 'An ordered, resizable collection of items.',
    body: 'List là tập hợp phần tử có thứ tự và co giãn kích thước (thêm, xóa, chèn). Tên gọi khác nhau: `list` (Python), `List` / `ArrayList` (Java), `Vec` (Rust), `slice` (Go). Khác mảng cố định ở chỗ thay đổi độ dài được.' },
  { title: 'UUID', match: /^uuid$/, aliases: 'uuid; guid; mã định danh duy nhất; unique id',
    desc: 'A 128-bit identifier that is practically unique without central coordination.',
    body: 'UUID là mã định danh 128 bit gần như không bao giờ trùng, sinh ra mà không cần máy chủ trung tâm. Hay dùng làm khóa chính và mã theo dõi.' },
];

const db = openDb();
const langRoots = new Set(db.prepare("SELECT title FROM nodes WHERE parent_id IS NULL AND (category = 'Language' OR title IN ('HTML','CSS','SQL'))").all().map((r) => r.title));
const rows = db.prepare('SELECT id, parent_id, title, kind, language, importance FROM nodes').all();
const byId = new Map(rows.map((r) => [r.id, r]));
const depth = (n) => { let d = 0; for (let p = n; p.parent_id !== null; p = byId.get(p.parent_id)) d++; return d; };
const ownTitle = (n) => (n.language && n.title.endsWith(`(${n.language})`) ? n.title.slice(0, -(n.language.length + 3)).trim() : n.title);
const rootOf = (n) => { let p = n; while (p.parent_id !== null) p = byId.get(p.parent_id); return p; };
// a node counts as language-tree content when its top ancestor is a language root
const inLanguageTree = (n) => n.parent_id !== null && langRoots.has(rootOf(n).title);

const ONE_PER_LANGUAGE = new Set(['Function', 'Variable', 'Data types', 'for', 'while']);
const renames = [];
const out = [];
for (const hub of HUBS) {
  // folders (kind item) are skipped: a hub linked to a section would be listed there as a child
  const matched = rows.filter((n) => n.kind !== 'item' && n.language && (inLanguageTree(n) || (n.parent_id === null && langRoots.has(n.language))) && hub.match.test(ownTitle(n).toLowerCase()));
  const perLang = new Map();
  for (const n of matched) {
    if (!perLang.has(n.language)) perLang.set(n.language, []);
    perLang.get(n.language).push(n);
  }
  const related = [];
  for (const list of perLang.values()) {
    list.sort((a, b) => depth(a) - depth(b) || b.importance - a.importance);
    related.push(...list.slice(0, ONE_PER_LANGUAGE.has(hub.title) ? 1 : 2));
  }
  // an existing node already using the hub's exact title keeps its language tag
  for (const n of rows) {
    if (n.title.toLowerCase() === hub.title.toLowerCase() && n.language && (n.parent_id !== null || langRoots.has(n.language))) renames.push({ n, hub });
  }
  for (const title of hub.also ?? []) {
    const extra = rows.find((n) => n.title === title);
    if (extra) related.push(extra);
  }
  out.push({ hub, related: [...new Set(related)] });
}

if (process.env.DRY) {
  for (const { hub, related } of out) console.log(`${hub.title}: ${related.length} liên quan | ${[...new Set(related.map((n) => n.language))].join(', ')}`);
  console.log('đổi tên:', renames.map((r) => `${r.n.title} -> ${r.n.title} (${r.n.language})`).join('; '));
  process.exit(0);
}

fs.copyFileSync(DB_PATH, path.join(ROOT, 'server', 'backups', `${new Date().toISOString().replace(/[:.]/g, '-')}-generic-hubs.db`));
const slugify = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
for (const { n } of renames) {
  const taken = (s) => db.prepare('SELECT 1 FROM nodes WHERE lower(title) = lower(?)').get(s);
  let title = `${n.title} (${n.language})`;
  if (taken(title)) title = `${n.language} ${n.title}`;
  n.newTitle = title;
  db.prepare('UPDATE nodes SET title = ?, slug = ? WHERE id = ?').run(title, slugify(title), n.id);
}

for (const hub of HUBS) {
  if (hub.was) db.prepare('UPDATE nodes SET title = ?, slug = ? WHERE title = ? AND language IS NULL AND parent_id IS NULL').run(hub.title, slugify(hub.title), hub.was);
}
const md = out
  .map(({ hub, related }) => {
    const titles = related.map((n) => n.newTitle ?? n.title);
    return [
      '@@ NODE', 'parent: -', `title: ${hub.title}`, 'kind: concept', 'category: Concept', 'importance: 8',
      `aliases: ${hub.aliases}`, `related: ${titles.join('; ')}`, `desc: ${hub.desc}`, '---', hub.body, '',
    ].join('\n');
  })
  .join('\n');
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, md);
db.close?.();
await importFiles([OUT]);

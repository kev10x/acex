/**
 * Seed the NTP3011 Skills Exam 2026 rubric.
 *
 * Usage:
 *   node scripts/seed-ntp3011-rubric.js --email=lecturer@example.com
 *
 * The rubric is created with rubric_type 'mark_sheet', which causes the PDF
 * report generator to render results as a filled-in mark-sheet table instead
 * of the default paragraph layout.
 */

const { query, initDatabase } = require('../server/database/connection');

const EMAIL_ARG = process.argv.find(a => a.startsWith('--email='));
const USER_EMAIL = EMAIL_ARG ? EMAIL_ARG.split('=')[1] : null;

if (!USER_EMAIL) {
  console.error('Usage: node scripts/seed-ntp3011-rubric.js --email=<lecturer-email>');
  process.exit(1);
}

const RUBRIC = {
  name: 'NTP3011 Skills Exam 2026 – Netmiko Router Configuration',
  rubric_type: 'mark_sheet',
  total_points: 30,
  criteria: [
    {
      name: 'SSH connection via ConnectHandler',
      max_points: 4,
      description:
        'ConnectHandler is imported from netmiko. The device dictionary contains all four required keys (device_type: "cisco_ios", host, username, password) and the correct values from the exam specification. The enable secret is also present.',
      levels: [
        { level: 'Full marks', points: 4, description: 'ConnectHandler used; device dictionary complete with correct device_type, host, username, password, and secret.' },
        { level: 'Partial', points: 2, description: 'ConnectHandler used and connection attempted but one or two keys are missing or incorrect (e.g., secret omitted, wrong device_type).' },
        { level: 'Not present', points: 0, description: 'ConnectHandler not used or device dictionary missing entirely.' }
      ]
    },
    {
      name: 'Enter privileged EXEC mode',
      max_points: 2,
      description:
        'connection.enable() is called after ConnectHandler succeeds to enter privileged EXEC mode using the enable secret.',
      levels: [
        { level: 'Full marks', points: 2, description: 'connection.enable() called correctly after the connection is established.' },
        { level: 'Not present', points: 0, description: 'enable() not called.' }
      ]
    },
    {
      name: 'Configure IP address and subnet mask (G2, G3, G4)',
      max_points: 5,
      description:
        'IP address and subnet mask are assigned to GigabitEthernet2 (10.1.1.1/255.255.255.0), GigabitEthernet3 (10.2.2.1/255.255.255.0), and GigabitEthernet4 (10.3.3.1/255.255.255.0). Award approximately 1–2 marks per correctly configured interface (1.5 marks each, rounded to nearest whole mark out of 5).',
      levels: [
        { level: 'All three interfaces', points: 5, description: 'All three interfaces have the correct ip address command with the right IP and mask.' },
        { level: 'Two interfaces', points: 3, description: 'Two interfaces correctly configured.' },
        { level: 'One interface', points: 2, description: 'One interface correctly configured.' },
        { level: 'None', points: 0, description: 'No ip address commands present or all incorrect.' }
      ]
    },
    {
      name: 'Apply interface descriptions (G2, G3, G4)',
      max_points: 3,
      description:
        'A description command is applied to each interface: "Link to LAN-A" on G2, "Link to LAN-B" on G3, "Link to LAN-C" on G4. Award 1 mark per correct description.',
      levels: [
        { level: 'All three', points: 3, description: 'Correct description applied to all three interfaces.' },
        { level: 'Two', points: 2, description: 'Correct description on two interfaces.' },
        { level: 'One', points: 1, description: 'Correct description on one interface.' },
        { level: 'None', points: 0, description: 'No descriptions applied.' }
      ]
    },
    {
      name: 'Bring interfaces up with no shutdown (G2, G3, G4)',
      max_points: 3,
      description:
        'no shutdown is issued on each of the three interfaces. Award 1 mark per interface.',
      levels: [
        { level: 'All three', points: 3, description: 'no shutdown on G2, G3, and G4.' },
        { level: 'Two', points: 2, description: 'no shutdown on two interfaces.' },
        { level: 'One', points: 1, description: 'no shutdown on one interface.' },
        { level: 'None', points: 0, description: 'no shutdown not used.' }
      ]
    },
    {
      name: 'Save running config to startup config',
      max_points: 2,
      description:
        'connection.save_config() (which issues write memory) is called after the configuration is applied.',
      levels: [
        { level: 'Full marks', points: 2, description: 'connection.save_config() called, or equivalent write memory command sent.' },
        { level: 'Not present', points: 0, description: 'Configuration not saved.' }
      ]
    },
    {
      name: 'Print show ip interface brief output',
      max_points: 2,
      description:
        'connection.send_command("show ip interface brief") is called and its output is printed to confirm the interfaces are configured and up.',
      levels: [
        { level: 'Full marks', points: 2, description: 'show ip interface brief sent and output printed.' },
        { level: 'Not present', points: 0, description: 'Verification command absent.' }
      ]
    },
    {
      name: 'try/except/finally error handling',
      max_points: 4,
      description:
        'The main logic is wrapped in a try/except/finally block. NetmikoTimeoutException (1 mark), NetmikoAuthenticationException (1 mark), and a general Exception (1 mark) are all caught. Each except block prints a clear, descriptive error message explaining the cause (1 mark for all three messages being descriptive).',
      levels: [
        { level: 'All three exceptions + descriptive messages', points: 4, description: 'All three exceptions caught with clear, descriptive error messages for each.' },
        { level: 'Two exceptions + messages', points: 3, description: 'Two of the three exceptions handled with descriptive messages.' },
        { level: 'One exception / partial messages', points: 2, description: 'One exception caught, or exceptions present but messages are not descriptive.' },
        { level: 'try/except block present but incomplete', points: 1, description: 'try/except structure present but exceptions not imported or not individually caught.' },
        { level: 'None', points: 0, description: 'No error handling.' }
      ]
    },
    {
      name: 'SSH session closed in finally block',
      max_points: 2,
      description:
        'The finally block calls connection.disconnect() (guarded by a None check if necessary) so the session is closed even when an exception occurs.',
      levels: [
        { level: 'Full marks', points: 2, description: 'finally block present; disconnect() called, guarded against None connection.' },
        { level: 'Partial', points: 1, description: 'disconnect() called but not in finally, or finally block present but disconnect missing.' },
        { level: 'Not present', points: 0, description: 'Session not closed in finally.' }
      ]
    },
    {
      name: 'Code quality',
      max_points: 2,
      description:
        'Code is readable with sensible variable names. Interfaces are handled via a loop or data structure (not hard-coded repetition for each interface). No unnecessary duplication.',
      levels: [
        { level: 'Full marks', points: 2, description: 'Loop/data-structure used for interface configuration; code is clean and readable.' },
        { level: 'Partial', points: 1, description: 'Code is mostly readable but interfaces are partially hard-coded, or minor quality issues.' },
        { level: 'Not present', points: 0, description: 'Each interface hard-coded separately with no loop; poor readability.' }
      ]
    },
    {
      name: 'Screenshot – show ip interface brief (up/up)',
      max_points: 1,
      description:
        'A screenshot is submitted showing the show ip interface brief output with GigabitEthernet2, GigabitEthernet3, and GigabitEthernet4 all in the up/up state.',
      levels: [
        { level: 'Provided and correct', points: 1, description: 'Screenshot shows all three interfaces up/up.' },
        { level: 'Missing or incorrect', points: 0, description: 'No screenshot, or interfaces not all up/up.' }
      ]
    }
  ]
};

(async () => {
  try {
    await initDatabase();

    const userRows = await query('SELECT id, name FROM users WHERE email = ?', [USER_EMAIL]);
    const users = userRows.rows || userRows;
    if (!users || users.length === 0) {
      console.error(`No user found with email: ${USER_EMAIL}`);
      process.exit(1);
    }
    const user = users[0];
    console.log(`Seeding rubric for user: ${user.name} (id=${user.id})`);

    const existing = await query(
      'SELECT id FROM rubrics WHERE user_id = ? AND name = ?',
      [user.id, RUBRIC.name]
    );
    const existingRows = existing.rows || existing;

    if (existingRows && existingRows.length > 0) {
      const id = existingRows[0].id;
      await query(
        'UPDATE rubrics SET criteria = ?, total_points = ?, rubric_type = ? WHERE id = ?',
        [JSON.stringify(RUBRIC.criteria), RUBRIC.total_points, RUBRIC.rubric_type, id]
      );
      console.log(`✅ Updated existing rubric (id=${id}): "${RUBRIC.name}"`);
    } else {
      const result = await query(
        'INSERT INTO rubrics (name, criteria, total_points, rubric_type, user_id) VALUES (?, ?, ?, ?, ?)',
        [RUBRIC.name, JSON.stringify(RUBRIC.criteria), RUBRIC.total_points, RUBRIC.rubric_type, user.id]
      );
      const newId = result.insertId || (result.rows && result.rows[0]?.id);
      console.log(`✅ Created rubric (id=${newId}): "${RUBRIC.name}"`);
    }

    console.log(`   ${RUBRIC.criteria.length} criteria, ${RUBRIC.total_points} total marks, type="${RUBRIC.rubric_type}"`);
    process.exit(0);
  } catch (err) {
    console.error('Seed failed:', err.message);
    process.exit(1);
  }
})();

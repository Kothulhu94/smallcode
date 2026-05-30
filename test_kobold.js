

(async () => {
  try {
    const body = {
      model: 'gemma-4-e4b-it',
      messages: [{
        role: 'user',
        content: 'Classify this user message into ONE of these categories. Reply with ONLY the category name, nothing else.\n\nCategories:\n- coding: creating new code/files\n- editing: modifying existing files\n- search: finding files or symbols\n- shell: running commands\n- explanation: answering questions, explaining concepts\n- multi_step: tasks with multiple sequential parts\n- debugging: fixing errors or bugs\n- backend: building Node.js/TypeScript backends (use BoneScript)\n\nUser message: "Create a minimal TypeScript browser project in the active workspace.Create exactly these files:- package.json- index.html- src/main.ts- src/style.cssUse the file tools to write the files.The result should be a tiny browser page that loads src/main.ts and shows a simple message on the page."\n\nPlease reply with ONLY the category name.'
      }],
      max_tokens: 64,
      temperature: 0.1
    };
    
    console.log("Sending classification request...");
    const res = await fetch('http://localhost:5001/v1/chat/completions', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body)
    });
    const data = await res.json();
    console.log("Classification status:", res.status);
    console.log(data.choices[0].message.content);

    // Also test the main generation that failed due to max_tokens = 8192 > max_context_length (8192)
    const body2 = {
      model: 'gemma-4-e4b-it',
      messages: [{
        role: 'system',
        content: 'You are SmallCode, a coding agent...'
      }],
      max_tokens: 4000, // Reduced from 8192 to prevent the "exceeding max_context_length" warning and truncation
      temperature: 0.1
    };
  } catch (err) {
    console.error(err);
  }
})();

const scene = document.getElementById('scene');
const choices = document.getElementById('choices');

function render(node) {
  scene.textContent = node.text;
  choices.innerHTML = '';
  (node.choices || []).forEach(c => {
    const btn = document.createElement('button');
    btn.className = 'choice-btn';
    btn.textContent = c.label;
    btn.onclick = () => render(c.next);
    choices.appendChild(btn);
  });
}

// Story will be defined here
render({ text: 'The story begins...', choices: [] });

let activeAction = "";
let loopingAction = false;
let loopTimestamp = 0;
let loopInterval = 1000;

let actions = [
  {
    name: "simple-up-down",
    description: "move up and down, extruding at the bottom and retracting at the top",
    key: "1",
    interval: 2000,
    __e: 1.5,
    __r: 1.5,
    __fe: 200.0,
    __fm: 600.0,
    __z: 5.0,
    gcode: [
      `G91`,
      `G0 Z__z F__fm`,
      `G0 Z{-__z * 2} F__fm`,
      // `G0 Z-__z F__fm`,
      `G1 F__fe E__e`,
      `G1 Z__z F__fm E-__r`,
      // `G0 Z__z F__fm`,
    ],
  },
];

function saveActions() {
  const data = JSON.stringify(actions);
  try {
    localStorage.setItem("actions", data);
    pushMessage("actions saved in local storage", "black");
  } catch (e) {
    pushMessage(`unable to save actions in local storage. ${e}`, "red");
  }
}

function loadActions() {
  const actionContainer = document.querySelector("#actions");
  actionContainer.innerHTML = "";

  const data = localStorage.getItem("actions");
  if (data) {
    actions = [];
    actions.push(...JSON.parse(data));
  }

  actions.forEach(a => {
    a.name = a.name.toLowerCase().replace(/[^a-zA-Z0-9]/g, '');
    const div = document.createElement("div");
    div.classList.add("action-item");
    div.id = `action-${a.name}`
    div.innerHTML = `
      <div class="action-meta-menu">
        <span class="action-modify-btn" onclick="editAction('${a.name}')">edit</span>
        <!-- <span class="action-modify-btn" onclick="duplicateAction('${a.name}')">duplicate</span> -->
        <span class="action-modify-btn" onclick="deleteAction('${a.name}')">delete</span>
      </div>
      <h1>${a.name}</h1>
      <p>${a.description}</p>
    `;
    const uiGroup = document.createElement("div");
    uiGroup.classList.add("ui-group");
    for (const key in a) {
      if (key.startsWith("__")) {
        const uiItem = document.createElement("div");
        uiItem.classList.add("ui-item");
        uiItem.classList.add("ui-item-interval");
        const input = document.createElement("input");
        const label = document.createElement("span");
        label.classList.add("label");
        label.textContent = key.slice(2);
        input.type = "number";
        input.step = 0.1;
        input.min = 0.0;
        input.value = a[key];
        input.id = `action-${a.name}-${key}`;
        uiItem.appendChild(label);
        uiItem.appendChild(input);
        uiGroup.appendChild(uiItem);
      }
    }
    div.appendChild(uiGroup);

    const uiGroup2 = document.createElement("div");
    uiGroup2.classList.add("ui-group");
    const uiItem = document.createElement("div");
    uiItem.classList.add("ui-item");
    const input = document.createElement("input");
    const label = document.createElement("span");
    label.classList.add("label");
    label.textContent = "interval";
    input.type = "number";
    input.step = 1;
    input.min = 0;
    input.value = a["interval"];
    input.id = `action-${a.name}-interval`;
    uiItem.appendChild(label);
    uiItem.appendChild(input);
    uiGroup2.appendChild(uiItem);
    div.appendChild(uiGroup2);

    const runBtn = document.createElement("div");
    runBtn.id = `action-${a.name}-run`;
    runBtn.classList.add("btn");
    runBtn.textContent = "run once";
    runBtn.addEventListener("click", () => {
      if (!fab.isPrinting) {
        pushMessage("initialize printer first", "red");
        return;
      }
      if (fab.commands.length > 0) {
        pushMessage("wait for gcode stream completion", "red");
        return;
      }
      let gcode = a.gcode.map(g => {

        const variables = [];
        for (const key in a) {
          variables.push(key);
        }
        variables.sort((a, b) => b.length - a.length);

        for (const key of variables) {
          if (key.startsWith("__")) {
            g = g.replaceAll(key, document.querySelector(`#action-${a.name}-${key}`).value);
          }
        }

        let expLocations = [];
        let close = false;
        for (let i = 0; i < g.length; i++) {
          if (g[i] === "{") {
            if (!close) {
              expLocations.push([i]);
              close = true;
            }
          }
          if (g[i] === "}") {
            if (close) {
              expLocations[expLocations.length - 1].push(i);
              close = false;
            }
          }
        }
        let characterCount = 0;
        expLocations.forEach(loc => {
          if (loc.length === 2) {
            const exp = g.slice(loc[0] + 1 - characterCount, loc[1] - characterCount);
            try {
              const result = eval(exp);
              g = g.slice(0, loc[0] - characterCount) + result.toFixed(3) + g.slice(loc[1] + 1 - characterCount);
              characterCount -= result.toFixed(3).length - exp.length - 2;
            } catch {
              pushMessage(`unable to evaluate expression ${exp} in action ${a.name}`, "red");
            }
          }
        });

        return g;
      });
      gcode = gcode.map(g => (checkGcode(g)));
      console.log(gcode);
      fab.commands.push(...gcode);
      fab.print();
      activeAction = a.name;
      pushMessage(`action ${a.name} ran`, "green");
    });

    const loopBtn = document.createElement("div");
    loopBtn.id = `action-${a.name}-loop`;
    loopBtn.classList.add("btn");
    loopBtn.textContent = "run loop";
    loopBtn.addEventListener("click", () => {
      if (!fab.isPrinting) {
        pushMessage("initialize printer first", "red");
        return;
      }

      if (fab.commands.length > 0 && !loopingAction) {
        pushMessage("wait for gcode stream completion", "red");
        return;
      }

      loopingAction = !loopingAction;
      if (loopingAction) {
        loopTimestamp = Date.now();
        runBtn.click();
        pushMessage(`action ${a.name} loop`, "green");
      } else {
        pushMessage(`action ${a.name} loop stopped`, "orange");
      }
    });

    div.appendChild(loopBtn);
    div.appendChild(runBtn);
    actionContainer.appendChild(div);
  });
}

function closeModal() {
  document.querySelector(".modal.active").classList.remove("active");
}

function initActionEditor() {
  document.querySelector("#add-action-btn").addEventListener("click", () => {
    document.querySelector(".modal").classList.add("active");
  });

  document.querySelector("#save-action-btn").addEventListener("click", () => {
    saveActions();
    const blob = new Blob([JSON.stringify(actions)], { type: 'text/plain' });

    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `actions.sewing3dp`;

    document.body.appendChild(link);
    link.click();

    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
  });

  document.querySelector("#load-action-btn").addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".sewing3dp";
    input.addEventListener("change", () => {
      const file = input.files[0];
      const reader = new FileReader();
      reader.onload = () => {
        actions = JSON.parse(reader.result);
        saveActions();
        loadActions();
        loadLocalData();
      };
      reader.readAsText(file);
    });
    input.click();
  });

  document.querySelector("#actions-add-variable-btn").addEventListener("click", () => {
    addVariable();
  });

  document.querySelector("#action-name").addEventListener("change", () => {
    document.querySelector("#action-name").value = document.querySelector("#action-name").value.toLowerCase().replace(/[^a-zA-Z0-9]/g, '');
  });

  document.querySelector("#actions-save-btn").addEventListener("click", () => {
    const name = document.querySelector("#action-name").value;
    const description = document.querySelector("#action-description").value;
    const gcode = document.querySelector("#action-gcode").value.split("\n");
    const variables = document.querySelectorAll(".action-variable-item");
    const action = {
      name,
      description,
      gcode,
      interval: 2000,
    };
    variables.forEach(v => {
      const key = v.querySelector(".action-variable-key").value;
      const val = v.querySelector(".action-variable-val").value;
      action[key] = val;
    });

    actions = actions.filter(a => a.name !== name);
    actions.push(action);

    let messages = "";
    if (name === "") {
      messages += "<li>name is required</li>";
    }
    if (gcode.length === 1 && gcode[0] === "") {
      messages += "<li>gcode is empty</li>";
    }
    if (messages !== "") {
      document.querySelector("#actions-editor-messages").innerHTML = messages;
      console.log(messages);
    } else {
      saveActions();
      loadActions();
      loadLocalData();
      closeModal();
    }
  });

  document.querySelector("#actions-eval-btn").addEventListener("click", () => {
    const gcode = document.querySelector("#action-gcode").value;
    evaluateGcode(gcode);
  });
}

function addVariable() {
  const container = document.querySelector("#action-variables-container");
  const div = document.createElement("div");
  div.classList.add("ui-item");
  div.classList.add("action-variable-item");
  const spanKey = document.createElement("span");
  spanKey.classList.add("label");
  spanKey.textContent = "key";
  const inputKey = document.createElement("input");
  inputKey.classList.add("action-variable-key");
  inputKey.type = "text";
  inputKey.placeholder = "__name";

  inputKey.addEventListener("change", () => {
    inputKey.value = `__` + inputKey.value.toLowerCase().replace(/[^a-zA-Z0-9]/g, '');
  });

  const spanVal = document.createElement("span");
  spanVal.classList.add("label");
  spanVal.textContent = "val";
  const inputVal = document.createElement("input");
  inputVal.classList.add("action-variable-val");
  inputVal.type = "number";
  inputVal.value = 0.0;
  const spanX = document.createElement("span");
  spanX.classList.add("close-btn");
  spanX.textContent = "×";

  spanX.addEventListener("click", () => {
    div.remove();
  });

  div.appendChild(spanKey);
  div.appendChild(inputKey);
  div.appendChild(spanVal);
  div.appendChild(inputVal);
  div.appendChild(spanX);
  container.appendChild(div);
}

function editAction(name) {
  document.querySelector("#action-name").value = name;
  document.querySelector("#action-description").value = actions.find(a => a.name === name).description;
  document.querySelector("#action-gcode").value = actions.find(a => a.name === name).gcode.join("\n");
  document.querySelector("#action-variables-container").innerHTML = "";
  for (const key in actions.find(a => a.name === name)) {
    if (key.startsWith("__")) {
      addVariable();
      document.querySelector("#action-variables-container .action-variable-item:last-child .action-variable-key").value = key;
      document.querySelector("#action-variables-container .action-variable-item:last-child .action-variable-val").value = actions.find(a => a.name === name)[key];
    }
  }
  document.querySelector(".modal").classList.add("active");
}

function duplicateAction(name) {
  const action = { ...actions.find(a => a.name === name) };
  action.name = action.name + "-copy";
  actions.push(action);
  saveActions();
  loadActions();
  console.log(actions);
}

function deleteAction(name) {
  actions = actions.filter(a => a.name !== name);
  saveActions();
  loadActions();
  loadLocalData();
  console.log(actions);
}

function evaluateGcode(gcode) {
  let messages = "";
  const actionModal = document.querySelector("#actions-editor-modal");
  const gcodeLines = gcode.split("\n");
  const evaluatedGcode = [];

  const variableItems = actionModal.querySelectorAll(".action-variable-item");
  const variables = {};
  variableItems.forEach(item => {
    const key = item.querySelector(".action-variable-key").value;
    const val = item.querySelector(".action-variable-val").value;
    variables[key] = val;
  });
  gcodeLines.forEach((line, ln) => {
    let evaluatedLine = line.replace(/__[a-zA-Z0-9]+/g, (match) => {
      if (!variables[match]) {
        messages += `<li>variable ${match} is not defined at line ${ln}</li>`;
        return match;
      }
      return variables[match];
    });

    let expLocations = [];
    let close = false;
    for (let i = 0; i < evaluatedLine.length; i++) {
      if (evaluatedLine[i] === "{") {
        if (!close) {
          expLocations.push([i]);
          close = true;
        } else {
          messages += `<li>unexpected { at line ${ln}</li>`;
        }
      }

      if (evaluatedLine[i] === "}") {
        if (close) {
          expLocations[expLocations.length - 1].push(i);
          close = false;
        } else {
          messages += `<li>unexpected } at line ${ln}</li>`;
        }
      }
    }

    let characterCount = 0;
    expLocations.forEach((loc, index) => {
      if (loc.length === 2) {
        const exp = evaluatedLine.slice(loc[0] + 1 - characterCount, loc[1] - characterCount);
        try {
          const result = eval(exp);
          evaluatedLine = evaluatedLine.slice(0, loc[0] - characterCount) + result.toFixed(3) + evaluatedLine.slice(loc[1] + 1 - characterCount);
          characterCount -= result.toFixed(3).length - exp.length - 2;
        } catch {
          messages += `<li>unable to evaluate expression ${exp} at line ${ln}</li>`;
        }
      } else {
        messages += `<li>unable to parse expression at line ${ln}</li>`;
      }
    })
    evaluatedGcode.push(evaluatedLine);
  });

  evaluatedGcode.forEach((line, ln) => {
    messages += `<li>${ln}: ${line}</li>`;
  });

  document.querySelector("#actions-editor-messages").innerHTML = messages;
  actionModal.scrollTop = actionModal.scrollHeight;
}
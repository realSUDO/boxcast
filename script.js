let TOTAL_BOXES = process.env.TOTAL_BOXES;
let container = document.querySelector(".main");

let matrix = new Array(TOTAL_BOXES).fill(0);

for (let i = 1; i <= TOTAL_BOXES; i++) {
	let checkbox = document.createElement("div");
	checkbox.classList.add("checkbox");
	checkbox.dataset.index = i;
	container.appendChild(checkbox);
}

container.addEventListener("click", (event) => {
	let clickedBox = event.target.closest(".checkbox");
	if (!clickedBox) return;

	let index = parseInt(clickedBox.dataset.index);

	clickedBox.classList.toggle("toggled");

	if (clickedBox.classList.contains("toggled")){
		matrix[index] = 1;
	} else {
		matrix[index] = 0;
	}

	console.log(`Box ${index} toggled to : ${matrix[index]}`);
});

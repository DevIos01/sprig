const { exec } = require('child_process');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');

function log(message) {
	const timestamp = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
	console.log(`[${timestamp}] ${message}`);
}

function parseArguments() {
	const args = process.argv.slice(2);
	const suspectFile = args[0];
	const gamesFolder = 'games';
	const resultFolder = '.github/moss_results';
	const splitFolders = ['.github/split1', '.github/split2'];
	return { suspectFile, gamesFolder, resultFolder, splitFolders };
}

async function splitFilesAsync(gamesFolder, splitFolders) {
	try {
		log(`Splitting files into ${splitFolders.length} groups...`);

		const jsFiles = await fsPromises.readdir(gamesFolder);
		const jsFilesFiltered = jsFiles.filter(file => file.endsWith('.js'));
		const filesPerGroup = Math.ceil(jsFilesFiltered.length / splitFolders.length);

		await Promise.all(splitFolders.map(folder => fsPromises.mkdir(folder, { recursive: true })));

		const promises = splitFolders.map((folder, index) => {
			const filesForThisGroup = jsFilesFiltered.slice(index * filesPerGroup, (index + 1) * filesPerGroup);
			return Promise.all(filesForThisGroup.map(file => {
				const sourceFile = path.join(gamesFolder, file);
				const destinationFile = path.join(folder, file);
				return fsPromises.copyFile(sourceFile, destinationFile);
			}));
		});

		await Promise.all(promises);

		log(`Files successfully split into ${splitFolders.length} groups.`);
	} catch (error) {
		log(`Error while splitting files: ${error.message}`);
		throw new Error('Failed to split files.');
	}
}

async function submitToMoss(suspectFile, folder) {
	try {
		log(`Submitting files to MOSS for ${folder}...`);

		const mossCommand = `perl .github/scripts/moss.pl -l javascript ${suspectFile} ${folder}/*.js`;
		return new Promise((resolve, reject) => {
			exec(mossCommand, (error, stdout, stderr) => {
				if (error) {
					log(`Error: ${error.message}`);
					return reject(new Error(`Failed to submit files to MOSS: ${error.message}`));
				}
				if (stderr) {
					log(`Perl STDERR: ${stderr}`);
				}

				const urlMatch = stdout.match(/http:\/\/moss\.stanford\.edu\/results\/\S+/);
				if (urlMatch) {
					const mossUrl = urlMatch[0];
					log(`MOSS Report URL: ${mossUrl}`);
					resolve(mossUrl);
				} else {
					log(`No valid MOSS URL found in output: ${stdout}`);
					reject(new Error('No valid MOSS URL found'));
				}
			});
		});
	} catch (error) {
		log(`Submission to MOSS failed: ${error.message}`);
		throw new Error('MOSS submission failed.');
	}
}

async function downloadMossReport(reportUrl, outputFolder, fileName) {
	try {
		log(`Downloading MOSS report from ${reportUrl}...`);
		const response = await axios({
			url: reportUrl,
			method: 'GET',
			responseType: 'stream'
		});

		if (!fs.existsSync(outputFolder)) {
			log(`Creating folder: ${outputFolder}`);
			fs.mkdirSync(outputFolder, { recursive: true });
		}

		const filePath = path.join(outputFolder, fileName);
		const writer = fs.createWriteStream(filePath);

		response.data.pipe(writer);

		await new Promise((resolve, reject) => {
			writer.on('finish', resolve);
			writer.on('error', reject);
		});

		log(`MOSS report saved to ${filePath}`);
	} catch (error) {
		log(`Failed to download report: ${error.message}`);
		throw new Error('Failed to download MOSS report.');
	}
}

function extractMossReportData(reportPath, suspectFile) {
	const htmlContent = fs.readFileSync(reportPath, 'utf-8');
	const $ = cheerio.load(htmlContent);
	const matches = [];

	$('tr').each((index, element) => {
		const file1 = $(element).find('td').eq(0).text().trim();
		const file2 = $(element).find('td').eq(1).text().trim();
		const linesMatched = $(element).find('td').eq(2).text().trim();

		if (file1.includes(suspectFile) || file2.includes(suspectFile)) {
			matches.push({
				file1,
				file2,
				linesMatched,
			});
		}
	});

	return matches;
}

function countFileLines(filePath) {
	const content = fs.readFileSync(filePath, 'utf-8');
	return content.split('\n').length;
}

function calculatePlagiarismPercentage(matchedLines, totalLines) {
	return ((matchedLines / totalLines) * 100).toFixed(2);
}

async function writeToMarkdown(filePath, lines) {
	const content = lines.join('\n');
	await fsPromises.writeFile(filePath, content);
	log(`Plagiarism report written to ${filePath}`);
}

async function processReports(resultFolder, suspectFile) {
	try {
		const reportFiles = ['report_split1.html', 'report_split2.html'].map(file => path.join(resultFolder, file));
		let highestPercentage = 0;
		let highestPercentageFile = '';
		const markdownLines = ["# Plagiarism Report", "## Game overlap report:"];

		for (const reportFile of reportFiles) {
			if (fs.existsSync(reportFile)) {
				const reportMatches = extractMossReportData(reportFile, suspectFile);

				for (const match of reportMatches) {
					const matchedLines = parseInt(match.linesMatched);
					const file2Path = match.file2.match(/\S+\.js/)[0];
					const cleanFilePath = path.basename(file2Path);

					if (cleanFilePath === path.basename(suspectFile)) {
						continue;
					}

					const file2FullPath = path.join(__dirname, '../../games', cleanFilePath);

					if (fs.existsSync(file2FullPath)) {
						const file2Lines = countFileLines(file2FullPath);
						const file2Percentage = calculatePlagiarismPercentage(matchedLines, file2Lines);

						if (file2Percentage >= 40) {
							log(`Plagiarism: ${file2Percentage}% of ${cleanFilePath}`);
							markdownLines.push(`${cleanFilePath}: ${file2Percentage}%`);

							if (file2Percentage > highestPercentage) {
								highestPercentage = file2Percentage;
								highestPercentageFile = cleanFilePath;
							}
						}
					} else {
						log(`Warning: File ${file2FullPath} does not exist.`);
					}
				}
			} else {
				log(`Warning: Report file ${reportFile} does not exist.`);
			}
		}

		if (highestPercentageFile) {
			markdownLines.length = 2;
			markdownLines.push(`${highestPercentageFile}: ${highestPercentage}%`);
		} else {
			markdownLines.push("\nNo significant overlap found.");
		}

		await writeToMarkdown(path.join(resultFolder, 'plagiarism-report.md'), markdownLines);
	} catch (error) {
		log(`Failed to process reports: ${error.message}`);
		throw new Error('Error processing MOSS reports.');
	}
}

async function main() {
	try {
		const { suspectFile, gamesFolder, resultFolder, splitFolders } = parseArguments();

		console.time('File Splitting');
		await splitFilesAsync(gamesFolder, splitFolders);
		console.timeEnd('File Splitting');

		log(`Submitting files to MOSS concurrently for ${splitFolders.length} splits...`);
		console.time('MOSS Submission');

		const reportUrls = await Promise.all(splitFolders.map(folder => submitToMoss(suspectFile, folder)));
		console.timeEnd('MOSS Submission');

		log(`Downloading MOSS reports concurrently for ${splitFolders.length} splits...`);
		console.time('MOSS Report Download');

		await Promise.all(reportUrls.map((url, index) => downloadMossReport(url, resultFolder, `report_split${index + 1}.html`)));
		console.timeEnd('MOSS Report Download');

		log('MOSS submission and download completed for all splits.');

		await processReports(resultFolder, suspectFile);
	} catch (error) {
		log(`Main process failed: ${error.message}`);
	}
}

main();
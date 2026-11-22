export const style = `
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  background: #f4f5f1;
  color: #203330;
  font:
    15px/1.55 system-ui,
    sans-serif;
  font-variant-numeric: tabular-nums;
}
main {
  max-width: 1080px;
  margin: auto;
  padding: 32px 24px 80px;
}
header,
.series {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
}
header {
  padding: 12px 0 30px;
}
header p {
  letter-spacing: 0.1em;
  color: #376c62;
  margin: 0;
}
h1 {
  font-size: clamp(26px, 4vw, 42px);
  margin: 0;
}
h2 {
  font-size: 22px;
  border-bottom: 2px solid #34675e;
  padding-bottom: 8px;
  margin: 0 0 20px;
}
h3 {
  margin: 0;
  font-size: 16px;
}
section {
  background: #fff;
  border: 1px solid #d4dcd5;
  border-radius: 8px;
  margin-bottom: 18px;
  padding: 24px;
}
article {
  margin: 16px 0 24px;
}
article:last-child {
  margin-bottom: 0;
}
a {
  color: #21685c;
}
small,
.axis,
.legend,
.resumes {
  color: #53675f;
  font-size: 12px;
}
.series strong {
  width: 175px;
  flex: none;
}
.graph {
  width: 100%;
  min-width: 0;
  margin: 8px 0;
}
.graph > svg {
  display: block;
  width: 100%;
  height: 82px;
  border-bottom: 1px solid #bdc9c2;
  background: #f5f8f5;
}
.break {
  stroke: #657f76;
  stroke-dasharray: 2 3;
  fill: none;
}
.axis,
.legend,
.resumes {
  display: flex;
  gap: 10px;
}
.axis {
  justify-content: space-between;
}
.legend,
.resumes {
  flex-wrap: wrap;
}
.legend i {
  width: 0.75em;
  height: 0.75em;
  display: inline-block;
  margin-right: 4px;
  border-radius: 2px;
}
.resumes {
  border-top: 1px solid #d4dcd5;
  padding-top: 12px;
}
.scroll {
  overflow-x: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
th,
td {
  text-align: left;
  padding: 6px;
  border-bottom: 1px solid #d4dcd5;
}
details,
section > h3 {
  margin-top: 20px;
}
select {
  padding: 7px;
  color: inherit;
}
aside {
  padding: 10px;
  background: #ffeec8;
}
ol {
  padding: 0;
  list-style: none;
}
li {
  margin: 12px 0;
}
li strong {
  float: right;
}
.strip {
  display: flex;
  height: 10px;
}
.strip i {
  position: relative;
}
.strip span {
  display: none;
  background: #fff;
  padding: 3px;
  white-space: nowrap;
}
.strip i:hover span {
  display: block;
  position: absolute;
  z-index: 1;
}
.empty {
  color: #63716b;
}
article > .graph {
  width: calc(100% - 195px);
}
.axis {
  position: relative;
  height: 20px;
}
.axis span {
  position: absolute;
}
.axis span:nth-child(2) {
  text-align: center;
}
.axis span:last-child {
  right: 0;
}
@media (max-width: 650px) {
  article > .graph {
    width: 100%;
  }
  main {
    padding: 12px;
  }
  header,
  .series {
    align-items: flex-start;
    flex-direction: column;
    gap: 4px;
  }
  section {
    padding: 14px;
  }
  .series strong {
    width: auto;
  }
}
`;

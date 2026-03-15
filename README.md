# DAG Optimizer – Compiler Design Project

## Overview
This project demonstrates **local code optimization using Directed Acyclic Graph (DAG)** in compiler design.  
It takes **Three Address Code (TAC)** as input, builds a **DAG representation of a basic block**, detects **common subexpressions**, and generates **optimized code** by removing redundant computations.

## Features
- Input Three Address Code (TAC)
- DAG construction for a basic block
- Common Subexpression Elimination (CSE)
- Visualization of the DAG
- Comparison of **before and after optimization**

## Example

### Input

t1 = a + b <br>
t2 = a + b <br>
t3 = t1 * c <br>
t4 = t2 * c <br>
t5 = t3 + t4 <br>
x = t5 <br> 


### Optimized Output

t1 = a + b <br>
t2 = t1 <br>
t3 = t1 * c <br>
t4 = t3 <br>
t5 = t3 + t3 <br>
x = t5 <br>


## Concepts Used
- Basic Blocks  
- Three Address Code (TAC)  
- Directed Acyclic Graph (DAG)  
- Common Subexpression Elimination  

## How to Run
1. Download the project.
2. Open `dag_optimizer.html` in any web browser.

## Author
**Yash Patel (202303103510038)**  
Compiler Design Project